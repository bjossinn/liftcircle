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
function firstKey(raw) {
  if (!raw) return void 0;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object") return parsed.default ?? Object.values(parsed)[0];
  } catch {
    return raw;
  }
  return void 0;
}
function env(name) {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}
function supabaseUrl() {
  return env("SUPABASE_URL");
}
function publishableKey() {
  const k = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? firstKey(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS"));
  if (!k) throw new Error("Missing SUPABASE_ANON_KEY / SUPABASE_PUBLISHABLE_KEYS");
  return k;
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
async function requireUser(req) {
  const header = req.headers.get("Authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new HttpError(401, "You need to be signed in.");
  const client = createClient(supabaseUrl(), publishableKey(), { auth: { persistSession: false, autoRefreshToken: false } });
  const auth = client.auth;
  if (typeof auth.getClaims === "function") {
    const { data: data2, error: error2 } = await auth.getClaims(token);
    const sub = data2?.claims?.sub;
    if (error2 || !sub || data2?.claims?.role !== "authenticated") {
      throw new HttpError(401, "Your session has expired. Please sign in again.");
    }
    return { id: sub, token };
  }
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, "Your session has expired. Please sign in again.");
  return { id: data.user.id, token };
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

// supabase/functions/delete-account/index.ts
Deno.serve(handler(async (req) => {
  const user = await requireUser(req);
  const admin2 = adminClient();
  const removed = {};
  for (const bucket of ["post-media", "avatars", "coach-public", "coach-docs"]) {
    removed[bucket] = await removeFolder(admin2, bucket, user.id);
  }
  const { data: rels, error: relErr } = await admin2.from("coaching_relationships").select("id").or(`coach_id.eq.${user.id},client_id.eq.${user.id}`);
  if (relErr) throw new Error(`relationships: ${relErr.message}`);
  removed["coach-media"] = 0;
  for (const r of rels ?? []) {
    removed["coach-media"] += await removeFolder(admin2, "coach-media", r.id);
  }
  const { error } = await admin2.auth.admin.deleteUser(user.id);
  if (error && !/not.?found/i.test(error.message)) throw new Error(`deleteUser: ${error.message}`);
  return json({ deleted: true, removedObjects: removed });
}));
