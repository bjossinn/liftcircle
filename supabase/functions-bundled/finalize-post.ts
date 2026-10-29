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
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

// supabase/functions/_shared/image.ts
function inspectImage(b) {
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return inspectJpeg(b);
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return inspectWebp(b);
  return { format: null, width: 0, height: 0, problems: ["not a JPEG or WebP image"] };
}
function ascii(b, at, n) {
  let s = "";
  for (let i = at; i < at + n && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}
var SOF = /* @__PURE__ */ new Set([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207]);
function inspectJpeg(b) {
  const info = { format: "jpeg", width: 0, height: 0, problems: [] };
  let i = 2;
  let scanned = false;
  while (i + 1 < b.length) {
    if (b[i] !== 255) {
      if (scanned) {
        i++;
        continue;
      }
      info.problems.push("corrupt JPEG marker structure");
      break;
    }
    let m = b[i + 1];
    while (m === 255 && i + 2 < b.length) {
      i++;
      m = b[i + 1];
    }
    if (m === 0 || m >= 208 && m <= 215 || m === 1 || m === 216) {
      i += 2;
      continue;
    }
    if (m === 217) break;
    if (i + 3 >= b.length) {
      info.problems.push("truncated JPEG");
      break;
    }
    const len = b[i + 2] << 8 | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) {
      info.problems.push("truncated JPEG segment");
      break;
    }
    if (m === 225) {
      const tag = ascii(b, i + 4, 6);
      info.problems.push(tag.startsWith("Exif") ? "contains EXIF metadata (may include GPS location)" : "contains APP1 (XMP) metadata");
    } else if (m === 237) {
      info.problems.push("contains IPTC/Photoshop metadata");
    } else if (SOF.has(m) && !info.width) {
      info.height = b[i + 5] << 8 | b[i + 6];
      info.width = b[i + 7] << 8 | b[i + 8];
    } else if (m === 218) {
      scanned = true;
    }
    i += 2 + len;
  }
  if (!info.width || !info.height) info.problems.push("could not read JPEG dimensions");
  return info;
}
function inspectWebp(b) {
  const info = { format: "webp", width: 0, height: 0, problems: [] };
  let i = 12;
  while (i + 8 <= b.length) {
    const fourcc = ascii(b, i, 4);
    const size = b[i + 4] | b[i + 5] << 8 | b[i + 6] << 16 | b[i + 7] << 24;
    const d = i + 8;
    if (size < 0 || d + size > b.length) {
      info.problems.push("truncated WebP chunk");
      break;
    }
    if (fourcc === "VP8X") {
      const flags = b[d];
      if (flags & 8) info.problems.push("contains EXIF metadata (may include GPS location)");
      if (flags & 4) info.problems.push("contains XMP metadata");
      if (flags & 2) info.problems.push("animated images are not supported");
      info.width = 1 + (b[d + 4] | b[d + 5] << 8 | b[d + 6] << 16);
      info.height = 1 + (b[d + 7] | b[d + 8] << 8 | b[d + 9] << 16);
    } else if (fourcc === "VP8 " && !info.width) {
      if (b[d + 3] === 157 && b[d + 4] === 1 && b[d + 5] === 42) {
        info.width = (b[d + 6] | b[d + 7] << 8) & 16383;
        info.height = (b[d + 8] | b[d + 9] << 8) & 16383;
      }
    } else if (fourcc === "VP8L" && !info.width) {
      if (b[d] === 47) {
        const bits = b[d + 1] | b[d + 2] << 8 | b[d + 3] << 16 | b[d + 4] << 24;
        info.width = (bits & 16383) + 1;
        info.height = (bits >>> 14 & 16383) + 1;
      }
    } else if (fourcc === "EXIF") {
      if (!info.problems.some((p) => p.includes("EXIF"))) info.problems.push("contains EXIF metadata (may include GPS location)");
    } else if (fourcc === "XMP ") {
      if (!info.problems.some((p) => p.includes("XMP"))) info.problems.push("contains XMP metadata");
    }
    i = d + size + (size & 1);
  }
  if (!info.width || !info.height) info.problems.push("could not read WebP dimensions");
  return info;
}
function validateImage(bytes, limits) {
  const info = inspectImage(bytes);
  if (bytes.length === 0) info.problems.push("empty file");
  if (bytes.length > limits.maxBytes) info.problems.push(`file is larger than ${Math.round(limits.maxBytes / 1024)} KB`);
  if (info.width > limits.maxSide || info.height > limits.maxSide) {
    info.problems.push(`image is larger than ${limits.maxSide} px on a side`);
  }
  return info;
}

// supabase/functions/finalize-post/index.ts
var BUCKET = "post-media";
var IMAGE_LIMITS = { maxBytes: 5 * 1024 * 1024, maxSide: 4096 };
var THUMB_LIMITS = { maxBytes: 512 * 1024, maxSide: 1024 };
Deno.serve(handler(async (req) => {
  const user = await requireUser(req);
  const { postId } = await readJson(req);
  if (!postId || !UUID_RE.test(postId)) throw new HttpError(400, "A valid post id is required.");
  const admin2 = adminClient();
  const { data: post, error: postErr } = await admin2.from("posts").select("id, author_id, status, deleted_at").eq("id", postId).maybeSingle();
  if (postErr) throw new Error(postErr.message);
  if (!post || post.author_id !== user.id) throw new HttpError(404, "Post not found.");
  if (post.deleted_at) throw new HttpError(410, "This post was deleted.");
  if (post.status === "published") return json({ id: postId, status: "published" });
  const { data: media, error: mediaErr } = await admin2.from("post_media").select("id, image_path, thumb_path, width, height").eq("post_id", postId).order("position");
  if (mediaErr) throw new Error(mediaErr.message);
  const report = [];
  const problems = [];
  for (const m of media ?? []) {
    const sizes = { image: null, thumb: null };
    for (const part of ["image", "thumb"]) {
      const path = part === "image" ? m.image_path : m.thumb_path;
      const { data: blob, error: error2 } = await admin2.storage.from(BUCKET).download(path);
      if (error2 || !blob) {
        problems.push({ mediaId: m.id, part, problem: "not uploaded yet" });
        continue;
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const info = validateImage(bytes, part === "image" ? IMAGE_LIMITS : THUMB_LIMITS);
      for (const p of info.problems) problems.push({ mediaId: m.id, part, problem: p });
      sizes[part] = { bytes: bytes.length, width: info.width, height: info.height };
    }
    if (sizes.image && sizes.thumb) {
      report.push({ id: m.id, width: sizes.image.width, height: sizes.image.height, bytes: sizes.image.bytes, thumb_bytes: sizes.thumb.bytes });
    }
  }
  if (problems.length) {
    const missing = problems.every((p) => p.problem === "not uploaded yet");
    throw new HttpError(422, missing ? "Some photos have not finished uploading." : "Some photos could not be accepted. Please re-select them and try again.", problems);
  }
  const { data, error } = await admin2.rpc("finalize_post_publish", { p_post_id: postId, p_user_id: user.id, p_media: report });
  if (error) throw new HttpError(409, error.message);
  return json(data);
}));
