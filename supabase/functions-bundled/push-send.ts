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

// supabase/functions/_shared/push/send.ts
function authorizePush(given, secret) {
  if (!secret || !given || given.length !== secret.length) return false;
  let r = 0;
  for (let i = 0; i < secret.length; i++) r |= secret.charCodeAt(i) ^ given.charCodeAt(i);
  return r === 0;
}
function tzParts(ms, timeZone) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}
function safeZone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz || "UTC" });
    return tz || "UTC";
  } catch {
    return "UTC";
  }
}
function offsetAt(ms, timeZone) {
  const p = tzParts(ms, timeZone);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1e3) * 1e3;
}
function zonedToUtc(date, hhmm, timeZone) {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - offsetAt(guess, timeZone);
  t = guess - offsetAt(t, timeZone);
  return new Date(t);
}
var toMin = (hhmm, fallback) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm ?? "");
  return m ? +m[1] % 24 * 60 + +m[2] : fallback;
};
function quietUntil(now, prefs) {
  const tz = safeZone(prefs?.timeZone);
  const start = toMin(prefs?.quietStart, 22 * 60);
  const end = toMin(prefs?.quietEnd, 7 * 60);
  if (start === end) return null;
  const p = tzParts(now.getTime(), tz);
  const m = p.h * 60 + p.mi;
  const inQuiet = start > end ? m >= start || m < end : m >= start && m < end;
  if (!inQuiet) return null;
  const today = `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
  const endStr = `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
  let at = zonedToUtc(today, endStr, tz);
  if (at.getTime() <= now.getTime()) {
    const next = new Date(Date.UTC(p.y, p.mo - 1, p.d) + 864e5).toISOString().slice(0, 10);
    at = zonedToUtc(next, endStr, tz);
  }
  return at;
}
var QUIET_EXEMPT = ["rest_over", "test"];
function sendOptionsFor(job) {
  const topic = job.payload.tag?.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || void 0;
  switch (job.kind) {
    case "rest_over":
      return { ttl: 300, urgency: "high", topic };
    case "test":
      return { ttl: 600, urgency: "normal", topic };
    case "workout_reminder":
    case "missed_nudge":
      return { ttl: 3 * 3600, urgency: "normal", topic };
    default:
      return { ttl: 24 * 3600, urgency: "normal", topic };
  }
}
async function processJob(deps, job) {
  const now = deps.now();
  if (!QUIET_EXEMPT.includes(job.kind)) {
    const until = quietUntil(now, job.prefs);
    if (until) return { id: job.id, status: "deferred", fireAt: until.toISOString() };
  }
  if (!job.subscriptions.length) return { id: job.id, status: "dropped" };
  const payload = JSON.stringify({ title: job.payload.title || "Hard Earned", body: job.payload.body ?? "", url: job.payload.url || "/", tag: job.payload.tag || job.kind });
  let ok = 0;
  let gone = 0;
  for (const sub of job.subscriptions) {
    let status = 0;
    try {
      status = await deps.send(sub, payload, sendOptionsFor(job));
    } catch {
      status = 0;
    }
    if (status >= 200 && status < 300) ok++;
    if (status === 404 || status === 410) gone++;
    if (status > 0) await deps.db.subscriptionResult(sub.endpoint, status);
  }
  if (ok > 0) return { id: job.id, status: "sent" };
  if (gone === job.subscriptions.length) return { id: job.id, status: "dropped" };
  return { id: job.id, status: "retry" };
}
async function runPushSend(deps, opts = {}) {
  const batch = opts.batch ?? 50;
  const budget = opts.budgetMs ?? 2e4;
  const maxBatches = opts.maxBatches ?? 10;
  const started = deps.now().getTime();
  const summary = { claimed: 0, sent: 0, deferred: 0, retry: 0, dropped: 0, cleaned: 0 };
  for (let b = 0; b < maxBatches && deps.now().getTime() - started < budget; b++) {
    const jobs = await deps.db.claimDue(batch);
    if (!jobs.length) break;
    summary.claimed += jobs.length;
    const results = [];
    for (const job of jobs) {
      const r = await processJob(deps, job);
      results.push(r);
      summary[r.status]++;
    }
    await deps.db.finish(results);
    if (jobs.length < batch) break;
  }
  summary.cleaned = await deps.db.cleanup();
  deps.log?.("push_send", summary);
  return summary;
}

// supabase/functions/_shared/push/webpush.ts
var enc = new TextEncoder();
function b64urlDecode(s) {
  const b64 = s.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - b64.length % 4) : "";
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlEncode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
var buf = (u) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", buf(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, buf(data)));
}
function ecJwk(publicRaw, privateRaw) {
  if (publicRaw.length !== 65 || publicRaw[0] !== 4) throw new Error("Expected a 65-byte uncompressed P-256 public key.");
  const jwk = { kty: "EC", crv: "P-256", x: b64urlEncode(publicRaw.slice(1, 33)), y: b64urlEncode(publicRaw.slice(33, 65)), ext: true };
  if (privateRaw) jwk.d = b64urlEncode(privateRaw);
  return jwk;
}
async function encryptPayload(plaintext, sub, opts = {}) {
  const uaPublic = b64urlDecode(sub.p256dh);
  const authSecret = b64urlDecode(sub.auth);
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const rs = opts.recordSize ?? 4096;
  if (plaintext.length + 1 + 16 > rs) throw new Error("Push payload too large.");
  let asPrivate;
  let asPublic;
  if (opts.sender) {
    asPublic = b64urlDecode(opts.sender.publicKey);
    asPrivate = await crypto.subtle.importKey("jwk", ecJwk(asPublic, b64urlDecode(opts.sender.privateKey)), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  } else {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    asPrivate = pair.privateKey;
    asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  }
  const uaKey = await crypto.subtle.importKey("jwk", ecJwk(uaPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asPrivate, 256));
  const prkKey = await hmac(authSecret, ecdhSecret);
  const keyInfo = concat(enc.encode("WebPush: info"), new Uint8Array([0]), uaPublic, asPublic);
  const ikm = await hmac(prkKey, concat(keyInfo, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode("Content-Encoding: aes128gcm"), new Uint8Array([0, 1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode("Content-Encoding: nonce"), new Uint8Array([0, 1])))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", buf(cek), { name: "AES-GCM" }, false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(nonce), tagLength: 128 }, key, buf(concat(plaintext, new Uint8Array([2])))));
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ct);
}
async function vapidAuthorization(endpoint, vapid, nowSec = Math.floor(Date.now() / 1e3)) {
  const aud = new URL(endpoint).origin;
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64urlEncode(enc.encode(JSON.stringify({ aud, exp: nowSec + 12 * 3600, sub: vapid.subject })));
  const pub = b64urlDecode(vapid.publicKey);
  const key = await crypto.subtle.importKey("jwk", ecJwk(pub, b64urlDecode(vapid.privateKey)), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, buf(enc.encode(`${header}.${claims}`))));
  return `vapid t=${header}.${claims}.${b64urlEncode(sig)}, k=${vapid.publicKey}`;
}
async function sendWebPush(sub, payload, vapid, fetchImpl, opts = {}) {
  const body = await encryptPayload(enc.encode(payload), sub);
  const headers = {
    Authorization: await vapidAuthorization(sub.endpoint, vapid),
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: String(Math.max(0, Math.round(opts.ttl ?? 3600))),
    Urgency: opts.urgency ?? "normal"
  };
  if (opts.topic && /^[A-Za-z0-9_-]{1,32}$/.test(opts.topic)) headers.Topic = opts.topic;
  const res = await fetchImpl(sub.endpoint, { method: "POST", headers, body });
  return res.status;
}

// supabase/functions/push-send/index.ts
Deno.serve(handler(async (req) => {
  if (!authorizePush(req.headers.get("x-push-secret"), Deno.env.get("PUSH_CRON_SECRET"))) throw new HttpError(401, "Not authorized.");
  const vapid = {
    publicKey: Deno.env.get("VAPID_PUBLIC_KEY") ?? "",
    privateKey: Deno.env.get("VAPID_PRIVATE_KEY") ?? "",
    subject: Deno.env.get("VAPID_SUBJECT") ?? ""
  };
  if (!vapid.publicKey || !vapid.privateKey || !vapid.subject) throw new HttpError(503, "VAPID keys are not configured.");
  const admin2 = adminClient();
  const rpc = async (fn, args) => {
    const { data, error } = await admin2.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };
  const summary = await runPushSend({
    db: {
      claimDue: (limit) => rpc("push_claim_due", { p_limit: limit }),
      finish: async (results) => void await rpc("push_finish", { p_results: results }),
      subscriptionResult: async (endpoint, status) => void await rpc("push_subscription_result", { p_endpoint: endpoint, p_status: status }),
      cleanup: () => rpc("push_cleanup", {})
    },
    send: (sub, payload, opts) => sendWebPush(sub, payload, vapid, (url, init) => fetch(url, { ...init, body: init.body, signal: AbortSignal.timeout(1e4) }), opts),
    now: () => /* @__PURE__ */ new Date(),
    // Content-free log: counts only.
    log: (event, fields) => console.log(JSON.stringify({ event, ...fields }))
  });
  return json(summary);
}));
