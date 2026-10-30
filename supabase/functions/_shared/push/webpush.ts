/**
 * Minimal Web Push sender: RFC 8291 message encryption (aes128gcm, RFC 8188) + RFC 8292 VAPID, using only WebCrypto
 * (works in the Supabase Edge Runtime / Deno and in Node for tests; no npm/jsr dependency).
 * Verified against the RFC 8291 §5 / Appendix A test vector in tests/unit/pushSend.test.ts.
 *
 * Keys are the base64url strings printed by `npx web-push generate-vapid-keys`:
 *   VAPID_PUBLIC_KEY  = 65-byte uncompressed P-256 point, VAPID_PRIVATE_KEY = 32-byte scalar.
 */

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}
export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  /** mailto: or https: contact (RFC 8292 "sub"). */
  subject: string;
}
export interface SendOptions {
  ttl?: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  /** ≤ 32 base64url characters; a newer message with the same topic replaces an undelivered one. */
  topic?: string;
}
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: Uint8Array }) => Promise<{ status: number; text: () => Promise<string> }>;

const enc = new TextEncoder();

export function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
const buf = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', buf(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, buf(data)));
}

/** P-256 JWK from an uncompressed public point (+ optional private scalar). */
function ecJwk(publicRaw: Uint8Array, privateRaw?: Uint8Array): JsonWebKey {
  if (publicRaw.length !== 65 || publicRaw[0] !== 4) throw new Error('Expected a 65-byte uncompressed P-256 public key.');
  const jwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: b64urlEncode(publicRaw.slice(1, 33)), y: b64urlEncode(publicRaw.slice(33, 65)), ext: true };
  if (privateRaw) jwk.d = b64urlEncode(privateRaw);
  return jwk;
}

export interface EncryptOptions {
  /** Test hooks: fixed salt and sender key pair (base64url). Random when absent. */
  salt?: Uint8Array;
  sender?: { publicKey: string; privateKey: string };
  recordSize?: number;
}

/** RFC 8291 aes128gcm body for one subscription. */
export async function encryptPayload(plaintext: Uint8Array, sub: Pick<PushSubscriptionKeys, 'p256dh' | 'auth'>, opts: EncryptOptions = {}): Promise<Uint8Array> {
  const uaPublic = b64urlDecode(sub.p256dh);
  const authSecret = b64urlDecode(sub.auth);
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const rs = opts.recordSize ?? 4096;
  if (plaintext.length + 1 + 16 > rs) throw new Error('Push payload too large.');

  let asPrivate: CryptoKey;
  let asPublic: Uint8Array;
  if (opts.sender) {
    asPublic = b64urlDecode(opts.sender.publicKey);
    asPrivate = await crypto.subtle.importKey('jwk', ecJwk(asPublic, b64urlDecode(opts.sender.privateKey)), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  } else {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
    asPrivate = pair.privateKey;
    asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  }
  const uaKey = await crypto.subtle.importKey('jwk', ecJwk(uaPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivate, 256));

  const prkKey = await hmac(authSecret, ecdhSecret);
  const keyInfo = concat(enc.encode('WebPush: info'), new Uint8Array([0]), uaPublic, asPublic);
  const ikm = await hmac(prkKey, concat(keyInfo, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm'), new Uint8Array([0, 1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce'), new Uint8Array([0, 1])))).slice(0, 12);

  const key = await crypto.subtle.importKey('raw', buf(cek), { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(nonce), tagLength: 128 }, key, buf(concat(plaintext, new Uint8Array([2])))));
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ct);
}

/** RFC 8292 VAPID Authorization header value for an endpoint. */
export async function vapidAuthorization(endpoint: string, vapid: VapidConfig, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(enc.encode(JSON.stringify({ aud, exp: nowSec + 12 * 3600, sub: vapid.subject })));
  const pub = b64urlDecode(vapid.publicKey);
  const key = await crypto.subtle.importKey('jwk', ecJwk(pub, b64urlDecode(vapid.privateKey)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  // WebCrypto returns the raw r||s (IEEE P1363) form JWS ES256 needs.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, buf(enc.encode(`${header}.${claims}`))));
  return `vapid t=${header}.${claims}.${b64urlEncode(sig)}, k=${vapid.publicKey}`;
}

/** Sends one encrypted push. Returns the push service's HTTP status (201/202 = accepted, 404/410 = subscription gone). */
export async function sendWebPush(sub: PushSubscriptionKeys, payload: string, vapid: VapidConfig, fetchImpl: FetchLike, opts: SendOptions = {}): Promise<number> {
  const body = await encryptPayload(enc.encode(payload), sub);
  const headers: Record<string, string> = {
    Authorization: await vapidAuthorization(sub.endpoint, vapid),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(Math.max(0, Math.round(opts.ttl ?? 3600))),
    Urgency: opts.urgency ?? 'normal',
  };
  if (opts.topic && /^[A-Za-z0-9_-]{1,32}$/.test(opts.topic)) headers.Topic = opts.topic;
  const res = await fetchImpl(sub.endpoint, { method: 'POST', headers, body });
  return res.status;
}
