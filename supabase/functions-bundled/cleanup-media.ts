// supabase/functions/_shared/http.ts
var corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cleanup-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
var HttpError = class extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
  status;
  details;
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function handler(fn) {
  return async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
    try {
      return await fn(req);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, details: e.details ?? null }, e.status);
      console.error(e);
      return json({ error: "Something went wrong on the server. Please try again." }, 500);
    }
  };
}

// supabase/functions/_shared/supabase.ts
import { createClient } from "npm:@supabase/supabase-js@2";
function env(name) {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}
function supabaseUrl() {
  return env("SUPABASE_URL");
}
function serviceKeys() {
  const keys = [Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), Deno.env.get("SUPABASE_SECRET_KEY")];
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") keys.push(...Object.values(parsed));
    } catch {
      keys.push(raw);
    }
  }
  return keys.filter((k) => Boolean(k));
}
var admin = null;
function adminClient() {
  if (!admin) {
    const key = serviceKeys()[0];
    if (!key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SECRET_KEYS");
    admin = createClient(supabaseUrl(), key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return admin;
}

// supabase/functions/_shared/storage.ts
async function listAllObjects(admin2, bucket, prefix) {
  const out = [];
  const pageSize = 1e3;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await admin2.storage.from(bucket).list(prefix, { limit: pageSize, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error(`list ${bucket}/${prefix}: ${error.message}`);
    if (!data?.length) break;
    for (const entry of data) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id === null || entry.id === void 0) out.push(...await listAllObjects(admin2, bucket, path));
      else out.push(path);
    }
    if (data.length < pageSize) break;
  }
  return out;
}
async function removeFolder(admin2, bucket, prefix) {
  const paths = await listAllObjects(admin2, bucket, prefix);
  for (let i = 0; i < paths.length; i += 500) {
    const { error } = await admin2.storage.from(bucket).remove(paths.slice(i, i + 500));
    if (error) throw new Error(`remove from ${bucket}: ${error.message}`);
  }
  return paths.length;
}

// supabase/functions/cleanup-media/index.ts
var BUCKET = "post-media";
var BUDGET_MS = 5e4;
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function authorize(req) {
  const secret = Deno.env.get("CLEANUP_SECRET");
  const given = req.headers.get("x-cleanup-secret");
  if (secret && given && timingSafeEqual(secret, given)) return;
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const apikey = req.headers.get("apikey") ?? "";
  for (const k of serviceKeys()) {
    if (bearer && timingSafeEqual(k, bearer) || apikey && timingSafeEqual(k, apikey)) return;
  }
  throw new HttpError(401, "Not authorized.");
}
Deno.serve(handler(async (req) => {
  authorize(req);
  const admin2 = adminClient();
  const started = Date.now();
  const summary = { deletedPosts: 0, abandonedDrafts: 0, objectsRemoved: 0, errors: [] };
  while (Date.now() - started < BUDGET_MS) {
    const { data, error } = await admin2.rpc("cleanup_media_candidates", { p_limit: 50 });
    if (error) throw new Error(error.message);
    const deleted = data?.deleted ?? [];
    const abandoned = data?.abandoned ?? [];
    if (!deleted.length && !abandoned.length) break;
    const doneDeleted = [];
    const doneAbandoned = [];
    for (const [list, done] of [[deleted, doneDeleted], [abandoned, doneAbandoned]]) {
      for (const c of list) {
        try {
          summary.objectsRemoved += await removeFolder(admin2, BUCKET, `${c.author_id}/${c.post_id}`);
          done.push(c.post_id);
        } catch (e) {
          summary.errors.push(`${c.post_id}: ${e.message}`);
        }
      }
    }
    const { error: doneErr } = await admin2.rpc("cleanup_media_done", { p_deleted: doneDeleted, p_abandoned: doneAbandoned });
    if (doneErr) throw new Error(doneErr.message);
    summary.deletedPosts += doneDeleted.length;
    summary.abandonedDrafts += doneAbandoned.length;
    if (!doneDeleted.length && !doneAbandoned.length) break;
  }
  return json(summary);
}));
