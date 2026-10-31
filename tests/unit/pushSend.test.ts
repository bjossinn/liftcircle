/**
 * push-send core with a MOCKED push service and an in-memory job store (no network):
 *  - RFC 8291 encryption matches the RFC's own test vector byte for byte; VAPID JWT verifies with the public key.
 *  - 410/404 delete the subscription; other failures count; success marks the job sent.
 *  - Quiet hours (user's time zone) defer jobs to the end of the window; rest-over alerts and test pushes are exempt.
 *  - Bounded batches; only the cron secret may trigger it.
 */
import { describe, expect, it } from 'vitest';
import { b64urlDecode, b64urlEncode, encryptPayload, sendWebPush, vapidAuthorization } from '../../supabase/functions/_shared/push/webpush';
import { authorizePush, processJob, quietUntil, runPushSend, zonedToUtc, type DueJob, type JobResult, type PushDb } from '../../supabase/functions/_shared/push/send';

/* RFC 8291 §5 and Appendix A */
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

describe('Web Push encryption and VAPID (RFC 8291 / RFC 8292)', () => {
  it('reproduces the RFC 8291 example message exactly', async () => {
    const body = await encryptPayload(new TextEncoder().encode(RFC.plaintext), { p256dh: RFC.uaPublic, auth: RFC.auth }, {
      salt: b64urlDecode(RFC.salt),
      sender: { publicKey: RFC.asPublic, privateKey: RFC.asPrivate },
    });
    expect(b64urlEncode(body)).toBe(RFC.body);
    // 86-byte header + 41 plaintext + 1 delimiter + 16 tag. (The RFC's example says "Content-Length: 145", but its
    // own base64url body decodes to 144 bytes.)
    expect(body.length).toBe(144);
  });

  it('VAPID Authorization: ES256 JWT for the endpoint origin, signed by the private key, with k = public key', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const pub = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
    const priv = (await crypto.subtle.exportKey('jwk', pair.privateKey)).d!;
    const h = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', { publicKey: pub, privateKey: priv, subject: 'mailto:owner@example.com' }, 1_800_000_000);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h)!;
    expect(m[4]).toBe(pub);
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(m[1])))).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(m[2])))).toEqual({ aud: 'https://fcm.googleapis.com', exp: 1_800_000_000 + 12 * 3600, sub: 'mailto:owner@example.com' });
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, b64urlDecode(m[3]) as BufferSource, new TextEncoder().encode(`${m[1]}.${m[2]}`) as BufferSource);
    expect(ok).toBe(true);
  });

  it('sendWebPush POSTs an aes128gcm body with TTL, Urgency and Topic headers (MOCKED push service)', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])) as CryptoKeyPair;
    const vapid = { publicKey: b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))), privateKey: (await crypto.subtle.exportKey('jwk', pair.privateKey)).d!, subject: 'mailto:a@b.c' };
    const calls: { url: string; headers: Record<string, string>; body: Uint8Array }[] = [];
    const status = await sendWebPush({ endpoint: 'https://push.example.net/p/1', p256dh: RFC.uaPublic, auth: RFC.auth }, '{"title":"Hi"}', vapid, async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return { status: 201, text: async () => '' };
    }, { ttl: 300, urgency: 'high', topic: 'rest' });
    expect(status).toBe(201);
    expect(calls[0].url).toBe('https://push.example.net/p/1');
    expect(calls[0].headers).toMatchObject({ 'Content-Encoding': 'aes128gcm', TTL: '300', Urgency: 'high', Topic: 'rest' });
    expect(calls[0].headers.Authorization).toMatch(/^vapid t=.+, k=/);
    expect(calls[0].body.length).toBe(86 + '{"title":"Hi"}'.length + 1 + 16);
  });
});

/* ------------------------------------------------------------------ the send loop */
const NOW = new Date('2026-11-02T12:00:00Z'); // 12:00 UTC = 13:00 in Oslo
const sub = (n: number) => ({ endpoint: `https://push.example.net/p/${n}`, p256dh: RFC.uaPublic, auth: RFC.auth });
const job = (over: Partial<DueJob> = {}): DueJob => ({
  id: 'j1', userId: 'u1', kind: 'workout_reminder', fireAt: NOW.toISOString(), attempts: 1,
  payload: { title: 'Hard Earned', body: 'Upper A today. Ready for a session?', url: '/', tag: 'workout' },
  prefs: { timeZone: 'Europe/Oslo', quietStart: '22:00', quietEnd: '07:00', kinds: ['workout_reminder'] },
  subscriptions: [sub(1)],
  ...over,
});
function memoryDb(batches: DueJob[][]) {
  const finished: JobResult[] = [];
  const subResults: [string, number][] = [];
  const db: PushDb = {
    claimDue: async () => batches.shift() ?? [],
    finish: async (r) => void finished.push(...r),
    subscriptionResult: async (e, s) => void subResults.push([e, s]),
    cleanup: async () => 3,
  };
  return { db, finished, subResults };
}
const service = (statuses: Record<string, number>) => {
  const sent: { endpoint: string; payload: string }[] = [];
  return {
    sent,
    send: async (s: { endpoint: string }, payload: string) => {
      sent.push({ endpoint: s.endpoint, payload });
      const st = statuses[s.endpoint] ?? 201;
      if (st === -1) throw new Error('network');
      return st;
    },
  };
};

describe('MOCKED push-send loop', () => {
  it('sends to every device, marks the job sent, and always includes a visible title/body/url/tag', async () => {
    const m = memoryDb([[job({ subscriptions: [sub(1), sub(2)] })]]);
    const s = service({});
    const summary = await runPushSend({ db: m.db, send: s.send, now: () => NOW });
    expect(s.sent).toHaveLength(2);
    expect(JSON.parse(s.sent[0].payload)).toEqual({ title: 'Hard Earned', body: 'Upper A today. Ready for a session?', url: '/', tag: 'workout' });
    expect(m.finished).toEqual([{ id: 'j1', status: 'sent' }]);
    expect(m.subResults).toEqual([[sub(1).endpoint, 201], [sub(2).endpoint, 201]]);
    expect(summary).toMatchObject({ claimed: 1, sent: 1, cleaned: 3 });
  });

  it('410 Gone reports the subscription (the SQL deletes it); all devices gone → job dropped', async () => {
    const m = memoryDb([[job()]]);
    await runPushSend({ db: m.db, send: service({ [sub(1).endpoint]: 410 }).send, now: () => NOW });
    expect(m.subResults).toEqual([[sub(1).endpoint, 410]]);
    expect(m.finished).toEqual([{ id: 'j1', status: 'dropped' }]);
  });

  it('one device gone, one fine → sent; transient failures → retry (failed_count reported); network error → retry', async () => {
    const a = memoryDb([[job({ subscriptions: [sub(1), sub(2)] })]]);
    await runPushSend({ db: a.db, send: service({ [sub(1).endpoint]: 404 }).send, now: () => NOW });
    expect(a.finished).toEqual([{ id: 'j1', status: 'sent' }]);
    const b = memoryDb([[job()]]);
    await runPushSend({ db: b.db, send: service({ [sub(1).endpoint]: 500 }).send, now: () => NOW });
    expect(b.finished).toEqual([{ id: 'j1', status: 'retry' }]);
    expect(b.subResults).toEqual([[sub(1).endpoint, 500]]);
    const c = memoryDb([[job()]]);
    await runPushSend({ db: c.db, send: service({ [sub(1).endpoint]: -1 }).send, now: () => NOW });
    expect(c.finished).toEqual([{ id: 'j1', status: 'retry' }]);
    expect(c.subResults).toEqual([]);
  });

  it('quiet hours in the user’s time zone defer the job to quiet_end; rest-over alerts and test pushes still go out', async () => {
    const night = new Date('2026-11-02T22:30:00Z'); // 23:30 in Oslo (UTC+1 in November)
    const m = memoryDb([[job({ id: 'r', kind: 'workout_reminder' }), job({ id: 'c', kind: 'coaching' }), job({ id: 'rest', kind: 'rest_over' }), job({ id: 't', kind: 'test' })]]);
    const s = service({});
    await runPushSend({ db: m.db, send: s.send, now: () => night });
    expect(m.finished).toEqual([
      { id: 'r', status: 'deferred', fireAt: '2026-11-03T06:00:00.000Z' }, // 07:00 Oslo
      { id: 'c', status: 'deferred', fireAt: '2026-11-03T06:00:00.000Z' },
      { id: 'rest', status: 'sent' },
      { id: 't', status: 'sent' },
    ]);
    expect(s.sent).toHaveLength(2);
  });

  it('quietUntil handles early-morning quiet time, no quiet window, and DST', () => {
    const p = { timeZone: 'Europe/Oslo', quietStart: '22:00', quietEnd: '07:00' };
    expect(quietUntil(new Date('2026-11-02T05:30:00Z'), p)?.toISOString()).toBe('2026-11-02T06:00:00.000Z'); // 06:30 Oslo
    expect(quietUntil(new Date('2026-11-02T12:00:00Z'), p)).toBeNull();
    expect(quietUntil(new Date('2026-11-02T23:00:00Z'), { ...p, quietStart: '07:00', quietEnd: '07:00' })).toBeNull();
    // Night before DST ends (Oslo 25 Oct 2026, 03:00 → 02:00): 07:00 local is 06:00Z.
    expect(quietUntil(new Date('2026-10-24T23:00:00Z'), p)?.toISOString()).toBe('2026-10-25T06:00:00.000Z');
    expect(zonedToUtc('2026-03-29', '07:00', 'Europe/Oslo').toISOString()).toBe('2026-03-29T05:00:00.000Z'); // after spring-forward
  });

  it('no device → dropped without calling the push service', async () => {
    const s = service({});
    expect(await processJob({ db: memoryDb([]).db, send: s.send, now: () => NOW }, job({ subscriptions: [] }))).toEqual({ id: 'j1', status: 'dropped' });
    expect(s.sent).toHaveLength(0);
  });

  it('bounded: stops at maxBatches and when a batch comes back short', async () => {
    const full = Array.from({ length: 2 }, (_, i) => job({ id: `a${i}` }));
    const m = memoryDb([full, full.map((j) => ({ ...j, id: `b${j.id}` })), full.map((j) => ({ ...j, id: `c${j.id}` }))]);
    const summary = await runPushSend({ db: m.db, send: service({}).send, now: () => NOW }, { batch: 2, maxBatches: 2 });
    expect(summary.claimed).toBe(4);
    const m2 = memoryDb([[job()], [job({ id: 'never' })]]);
    await runPushSend({ db: m2.db, send: service({}).send, now: () => NOW }, { batch: 5 });
    expect(m2.finished.map((r) => r.id)).toEqual(['j1']);
  });

  it('only the cron secret can trigger push-send', () => {
    expect(authorizePush('s3cret-value', 's3cret-value')).toBe(true);
    expect(authorizePush(null, 's3cret-value')).toBe(false);
    expect(authorizePush('s3cret-valuX', 's3cret-value')).toBe(false);
    expect(authorizePush('s3cret', 's3cret-value')).toBe(false);
    expect(authorizePush('anything', undefined)).toBe(false); // secret not configured → nobody
    expect(authorizePush('', '')).toBe(false);
  });
});
