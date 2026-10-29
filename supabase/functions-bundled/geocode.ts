// supabase/functions/geocode/index.ts
import { createClient as createClient2 } from "npm:@supabase/supabase-js@2";

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
async function readJson(req) {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, "Invalid request body.");
  }
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

// supabase/functions/geocode/index.ts
var PROVIDER = (Deno.env.get("GEOCODER") ?? "none").trim().toLowerCase();
var CONTACT = (Deno.env.get("GEOCODER_CONTACT_EMAIL") ?? "").trim();
var BASE = (Deno.env.get("NOMINATIM_URL") ?? "https://nominatim.openstreetmap.org").replace(/\/+$/, "");
var USER_AGENT = `LiftCircle/1.0 (coach directory geocoding; contact: ${CONTACT || "unset"})`;
var nextSlot = 0;
async function throttle() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  if (at - now > 5e3) throw new HttpError(429, "Location search is busy right now. Please try again in a few seconds.");
  nextSlot = at + 1100;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}
var perUser = /* @__PURE__ */ new Map();
function userBurstLimit(uid) {
  const now = Date.now();
  const list = (perUser.get(uid) ?? []).filter((t) => now - t < 6e4);
  if (list.length >= 10) throw new HttpError(429, "Too many location searches. Please wait a minute.");
  list.push(now);
  perUser.set(uid, list);
  if (perUser.size > 5e3) perUser.clear();
}
var cache = /* @__PURE__ */ new Map();
var CACHE_MS = 24 * 3600 * 1e3;
var round3 = (n) => Math.round(n * 1e3) / 1e3;
function mapRow(r) {
  const lat = Number(r.lat);
  const lng = Number(r.lon);
  const a = r.address ?? {};
  const country = (a.country_code ?? "").toUpperCase();
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !/^[A-Z]{2}$/.test(country)) return null;
  const city = a.city ?? a.town ?? a.village ?? a.municipality ?? a.hamlet ?? a.suburb ?? null;
  const region = a.state ?? a.region ?? a.county ?? a.state_district ?? null;
  return {
    label: (r.display_name ?? [city, region, country].filter(Boolean).join(", ")).slice(0, 200),
    city: city ?? null,
    region: region ?? null,
    country,
    lat: round3(lat),
    lng: round3(lng)
  };
}
async function nominatim(query, lang) {
  const key = `${lang ?? ""}|${query.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.results;
  await throttle();
  const url = new URL(`${BASE}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "5");
  url.searchParams.set("email", CONTACT);
  const headers = { "User-Agent": USER_AGENT, Accept: "application/json" };
  if (lang) headers["Accept-Language"] = lang;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8e3) });
  if (!res.ok) throw new Error(`nominatim ${res.status}`);
  const rows = await res.json();
  const results = (Array.isArray(rows) ? rows : []).map(mapRow).filter((x) => x !== null).slice(0, 5);
  cache.set(key, { at: Date.now(), results });
  if (cache.size > 1e3) cache.delete(cache.keys().next().value);
  return results;
}
Deno.serve(handler(async (req) => {
  const user = await requireUser(req);
  const { query } = await readJson(req);
  const q = typeof query === "string" ? query.trim().replace(/\s+/g, " ") : "";
  if (q.length < 2 || q.length > 200) throw new HttpError(400, "Type a town, city or region (2\u2013200 characters).");
  if (PROVIDER !== "nominatim" || !CONTACT) {
    return json({ available: false, results: [], reason: "not_configured" });
  }
  userBurstLimit(user.id);
  const userClient = createClient2(supabaseUrl(), publishableKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${user.token}` } }
  });
  const quota = await userClient.rpc("coaching_geocode_quota");
  if (quota.error && (quota.error.code === "PT429" || /too many/i.test(quota.error.message))) {
    throw new HttpError(429, quota.error.message || "Too many location searches. Please wait a few minutes.");
  }
  const lang = req.headers.get("Accept-Language")?.split(",")[0]?.trim().slice(0, 20) || null;
  try {
    return json({ available: true, results: await nominatim(q, lang) });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    console.error("geocode upstream error", e);
    return json({ available: false, results: [], reason: "provider_down" });
  }
}));
