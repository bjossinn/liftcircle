/**
 * push-send core with a MOCKED push service and an in-memory job store (no network):
 *  - RFC 8291 encryption matches the RFC's own test vector byte for byte; VAPID JWT verifies with the public key.
 *  - 410/404 delete the subscription; other failures count; success marks the job sent.
 *  - Quiet hours (user's time zone) defer jobs to the end of the window; rest-over alerts and test pushes are exempt.
 *  - Bounded batches; only the cron secret may trigger it.
 *  - Coach reminders (roadmap item 9): two server checks (prepare → dispatch) around the copy, the attempt token on
 *    every settlement, exact approved fallbacks for every AI failure, language/consent changes between the checks,
 *    ambiguous transport outcomes, and rest alerts settled before any model call. The model is a MOCKED provider.
 */
import { describe, expect, it } from 'vitest';
import { b64urlDecode, b64urlEncode, encryptPayload, sendWebPush, vapidAuthorization } from '../../supabase/functions/_shared/push/webpush';
import { authorizePush, processCoachJob, processJob, quietUntil, runPushSend, zonedToUtc, type CachedCopy as CachedCopyT, type CheckResult, type DueJob, type JobResult, type PushDb } from '../../supabase/functions/_shared/push/send';
import {
  COPY_MAX_CODE_POINTS,
  DEFAULT_PUSH_OPENAI_MODEL,
  DEFAULT_PUSH_REASONING_EFFORT,
  fallbackBody,
  finalizeCopy,
  resolvePushModel,
  validateCopy,
  writeCopy,
  type CoachKind,
} from '../../supabase/functions/_shared/push/copy';
import { DEFAULT_OPENAI_MODEL, resolveProvider } from '../../supabase/functions/_shared/ai/provider';
import { judgeProblems } from '../../supabase/functions/_shared/push/judge';
import { SHARED_EN } from '../../supabase/functions/_shared/i18n/messages.en';
import { SHARED_IS } from '../../supabase/functions/_shared/i18n/messages.is';

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
  id: 'j1', userId: 'u1', kind: 'coaching', fireAt: NOW.toISOString(), attempts: 1,
  payload: { title: 'Hard Earned', body: 'Upper A today. Ready for a session?', url: '/', tag: 'workout' },
  prefs: { timeZone: 'Europe/Oslo', quietStart: '22:00', quietEnd: '07:00', kinds: ['workout_reminder', 'coaching'] },
  subscriptions: [sub(1)],
  ...over,
});
function memoryDb(batches: DueJob[][], checks: (id: string, stage: 'prepare' | 'dispatch') => CheckResult = () => ({ status: 'ok', language: 'en' })) {
  const finished: JobResult[] = [];
  const finishCalls: JobResult[][] = [];
  const subResults: [string, number][] = [];
  const checked: [string, string, string][] = [];
  const stored: (CachedCopyT | null)[] = [];
  const db: PushDb = {
    claimDue: async () => batches.shift() ?? [],
    finish: async (r) => {
      finishCalls.push(r);
      finished.push(...r);
    },
    subscriptionResult: async (e, s) => void subResults.push([e, s]),
    cleanup: async () => 3,
    check: async (id, token, stage, copy) => {
      checked.push([id, token, stage]);
      if (stage === 'dispatch') stored.push(copy ?? null);
      return checks(id, stage);
    },
  };
  return { db, finished, finishCalls, subResults, checked, stored };
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
    const m = memoryDb([[
      job({ id: 'r', kind: 'workout_reminder', token: 'tok-r', eventDate: '2026-11-02', expiresAt: '2026-11-02T23:00:00.000Z' }),
      job({ id: 'c', kind: 'coaching' }), job({ id: 'rest', kind: 'rest_over' }), job({ id: 't', kind: 'test' }),
    ]]);
    const s = service({});
    await runPushSend({ db: m.db, send: s.send, now: () => night });
    expect(m.finished).toEqual([
      { id: 'c', status: 'deferred', fireAt: '2026-11-03T06:00:00.000Z' }, // 07:00 Oslo
      { id: 'rest', status: 'sent' },
      { id: 't', status: 'sent' },
      // A coach reminder can't be deferred past its own local day: discarded, never caught up the next morning.
      { id: 'r', token: 'tok-r', status: 'discarded', reason: 'quiet_hours' },
    ]);
    expect(s.sent).toHaveLength(2);
    expect(m.checked).toEqual([]); // no server check and no copy for a reminder that can't go out
  });

  it('a coach reminder inside early-morning quiet hours is deferred within its own day; daytime and equal quiet hours', async () => {
    const early = new Date('2026-11-02T05:30:00Z'); // 06:30 Oslo
    const r = job({ id: 'r', kind: 'missed_nudge', token: 'tok', eventDate: '2026-11-02', expiresAt: '2026-11-02T23:00:00.000Z' });
    const m = memoryDb([]);
    expect(await processCoachJob({ db: m.db, send: service({}).send, now: () => early }, r, 10_000)).toEqual({ id: 'r', token: 'tok', status: 'deferred', fireAt: '2026-11-02T06:00:00.000Z' });
    // Daytime quiet hours (12:00–14:00) and the 13:00 Oslo send time → deferred to 14:00.
    const day = { ...r, prefs: { ...r.prefs, quietStart: '12:00', quietEnd: '14:00' } };
    expect(await processCoachJob({ db: m.db, send: service({}).send, now: () => NOW }, day, 10_000)).toMatchObject({ status: 'deferred', fireAt: '2026-11-02T13:00:00.000Z' });
    // Equal start and end: no quiet hours, it goes out.
    const off = { ...r, prefs: { ...r.prefs, quietStart: '07:00', quietEnd: '07:00' } };
    expect(await processCoachJob({ db: m.db, send: service({}).send, now: () => early }, off, 10_000)).toMatchObject({ status: 'sent' });
    // An expired candidate is discarded before any check.
    const late = new Date('2026-11-02T23:30:00Z');
    expect(await processCoachJob({ db: memoryDb([]).db, send: service({}).send, now: () => late }, { ...r, prefs: { ...r.prefs, quietStart: '00:00', quietEnd: '00:00' } }, 10_000)).toMatchObject({ status: 'discarded', reason: 'expired' });
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

/* ------------------------------------------------------------------ coach reminders (roadmap item 9) */
const OPENAI_ENV: Record<string, string> = { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key', OPENAI_MODEL: 'gpt-4.1-mini', PUSH_AI_COPY: 'on' };
const env = (over: Record<string, string> = {}) => (name: string) => ({ ...OPENAI_ENV, ...over })[name];
const AI_OK = { enabled: true, paused: false, consentAt: '2026-11-01T10:00:00Z', consentVersion: '2026-10-29:openai', training: true, nutrition: true };
const coachJob = (over: Partial<DueJob> = {}) =>
  job({ id: 'w', kind: 'workout_reminder', token: 'tok-w', eventDate: '2026-11-02', expiresAt: '2026-11-02T23:00:00.000Z', ...over });

/** A MOCKED OpenAI-compatible provider. */
function provider(reply: string | ((body: unknown) => string) | 'timeout' | 'error' | number) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetch = async (url: string, init: { body: string; signal?: AbortSignal }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ url, body });
    if (reply === 'timeout') {
      return new Promise<never>((_, rej) => init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    if (reply === 'error') throw new Error('network down');
    if (typeof reply === 'number') return { ok: false, status: reply, headers: { get: () => null }, json: async () => ({}), text: async () => '{}' };
    const content = typeof reply === 'function' ? reply(body) : reply;
    const data = { choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 120, completion_tokens: 18 } };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => data, text: async () => JSON.stringify(data) };
  };
  return { calls, fetch };
}
const sentBody = (s: ReturnType<typeof service>, i = 0) => JSON.parse(s.sent[i].payload) as { title: string; body: string; url: string; tag: string };

describe('coach reminders: deterministic checks around the copy', () => {
  it('prepare → fallback copy in the account language → dispatch → send; the claim token settles it with the cached copy', async () => {
    const m = memoryDb([[coachJob()]], () => ({ status: 'ok', language: 'is', ai: null }));
    const s = service({});
    const summary = await runPushSend({ db: m.db, send: s.send, now: () => NOW });
    expect(m.checked).toEqual([['w', 'tok-w', 'prepare'], ['w', 'tok-w', 'dispatch']]);
    expect(sentBody(s)).toEqual({ title: 'Hard Earned', body: SHARED_IS['push.coachWorkout.body'], url: '/', tag: 'workout' });
    expect(m.finished).toEqual([{ id: 'w', token: 'tok-w', status: 'sent', copy: { body: SHARED_IS['push.coachWorkout.body'], language: 'is', source: 'fallback' } }]);
    expect(summary).toMatchObject({ sent: 1, modelCalls: 0, fallbackCopy: 1, aiCopy: 0 });
  });

  it('every kind has its exact approved fallback, title and destination (food opens the food log)', async () => {
    for (const [kind, key, url, tag] of [
      ['workout_reminder', 'push.coachWorkout', '/', 'workout'],
      ['missed_nudge', 'push.coachMissed', '/', 'workout'],
      ['food_unlogged', 'push.coachFood', '/nutrition/log', 'food'],
    ] as const) {
      for (const [lang, dict] of [['en', SHARED_EN], ['is', SHARED_IS]] as const) {
        const s = service({});
        await processCoachJob({ db: memoryDb([], () => ({ status: 'ok', language: lang })).db, send: s.send, now: () => NOW }, coachJob({ kind }), 10_000);
        expect(sentBody(s)).toEqual({ title: dict[`${key}.title`], body: dict[`${key}.body`], url, tag });
        expect(validateCopy(JSON.stringify({ body: dict[`${key}.body`] }), lang, kind)).toBe(dict[`${key}.body`]);
      }
    }
  });

  it('a server discard (opt-out, pause, quota, already trained, stale sync) or a lost claim sends nothing and reports nothing', async () => {
    for (const verdict of [{ status: 'discard', reason: 'snoozed' }, { status: 'lost' }] as CheckResult[]) {
      for (const stage of ['prepare', 'dispatch'] as const) {
        const m = memoryDb([[coachJob()]], (_id, st) => (st === stage ? verdict : { status: 'ok', language: 'en' }));
        const s = service({});
        await runPushSend({ db: m.db, send: s.send, now: () => NOW });
        expect(s.sent).toHaveLength(0);
        expect(m.finished).toEqual([]);
      }
    }
  });

  it('an unknown delivery outcome is ambiguous (never resent); a definite push-service failure is retried; a database without push_check releases the job', async () => {
    const a = memoryDb([[coachJob()]]);
    await runPushSend({ db: a.db, send: service({ [sub(1).endpoint]: -1 }).send, now: () => NOW });
    expect(a.finished).toMatchObject([{ id: 'w', token: 'tok-w', status: 'ambiguous' }]);
    const b = memoryDb([[coachJob()]]);
    await runPushSend({ db: b.db, send: service({ [sub(1).endpoint]: 503 }).send, now: () => NOW });
    expect(b.finished).toMatchObject([{ id: 'w', token: 'tok-w', status: 'retry' }]);
    const c = memoryDb([[coachJob()]]);
    delete c.db.check;
    await runPushSend({ db: c.db, send: service({}).send, now: () => NOW });
    expect(c.finished).toEqual([{ id: 'w', token: 'tok-w', status: 'release' }]);
    const d = memoryDb([[coachJob()]]);
    d.db.check = async () => {
      throw new Error('db down');
    };
    await runPushSend({ db: d.db, send: service({}).send, now: () => NOW });
    expect(d.finished).toEqual([{ id: 'w', token: 'tok-w', status: 'release' }]);
  });

  it('rest alerts, tests and social pushes are settled before any model call; jobs that no longer fit the budget are released', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const p = provider('{"body":"When it suits you, open Today to see your workout."}');
    const slowFetch = async (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => {
      await gate;
      return p.fetch(url, init);
    };
    const m = memoryDb([[coachJob(), job({ id: 'rest', kind: 'rest_over' })]], () => ({ status: 'ok', language: 'en', ai: AI_OK }));
    const run = runPushSend({ db: m.db, send: service({}).send, now: () => NOW, copy: { env: env(), fetch: slowFetch } });
    await new Promise((r) => setTimeout(r, 20));
    expect(m.finishCalls).toEqual([[{ id: 'rest', status: 'sent' }]]); // settled while the model is still writing
    release();
    await run;
    expect(m.finishCalls[1]).toMatchObject([{ id: 'w', status: 'sent' }]);
    // Budget: the clock is already past the budget when coach reminders are reached → released untouched.
    let t = NOW.getTime();
    const slowService = service({});
    const slowSend: typeof slowService.send = async (sub, payload) => {
      t += 25_000; // a very slow push service eats the whole budget
      return slowService.send(sub, payload);
    };
    const m2 = memoryDb([[coachJob(), job({ id: 'rest', kind: 'rest_over' })]]);
    await runPushSend({ db: m2.db, send: slowSend, now: () => new Date(t) }, { budgetMs: 20_000 });
    expect(m2.finished).toEqual([{ id: 'rest', status: 'sent' }, { id: 'w', token: 'tok-w', status: 'release' }]);
  });
});

describe('coach reminders: the model writes only the body', () => {
  it('generated Icelandic copy is used when AI is enabled, consented for this provider and the scope is shared', async () => {
    const p = provider('{"body":"Æfing dagsins bíður þín í Í dag þegar þér hentar."}');
    const m = memoryDb([[coachJob()]], () => ({ status: 'ok', language: 'is', ai: AI_OK }));
    const s = service({});
    const summary = await runPushSend({ db: m.db, send: s.send, now: () => NOW, copy: { env: env(), fetch: p.fetch } });
    expect(p.calls).toHaveLength(1);
    expect(sentBody(s)).toEqual({ title: 'Hard Earned', body: 'Æfing dagsins bíður þín í Í dag þegar þér hentar.', url: '/', tag: 'workout' });
    expect(m.finished).toMatchObject([{ status: 'sent', copy: { language: 'is', source: 'ai' } }]);
    expect(summary).toMatchObject({ modelCalls: 1, aiCopy: 1, inputTokens: 120, outputTokens: 18 });
    // The request carries no identity, chat, workout names, foods, measurements or targets — and no tools, one attempt.
    const req = JSON.stringify(p.calls[0].body);
    const userPart = JSON.stringify((p.calls[0].body.messages as { role: string }[]).filter((x) => x.role === 'user'));
    expect(req).not.toMatch(/Upper A|"u1"|tok-w/);
    expect(userPart).not.toMatch(/kg|calor|weight|name/i);
    expect(p.calls[0].body).not.toHaveProperty('tools');
    expect(req).toContain(SHARED_IS['push.coachWorkout.body']); // the approved fallback as the writing reference
  });

  it('invalid output, wrong language, guilt, numbers, extra keys, too long, provider errors and timeouts → the exact fallback', async () => {
    const bad = [
      'Sure! {"body":"Open Today when it suits you."}',
      '{"body":"Open Today when it suits you.","title":"Hi"}',
      '{"body":"Opnaðu Í dag þegar þér hentar."}', // Icelandic for an English account
      '{"body":"You skipped yesterday, make up for it today."}',
      '{"body":"Burn 300 calories with 20 minutes today."}',
      '{"body":"Open https://example.com now."}',
      `{"body":"${'Open Today when it suits you. '.repeat(6).trim()}"}`,
      '{"body":"Open Today\\nwhen it suits you."}',
      '{"body":""}',
      '{"body":"Eat more calories."}',
      '{"body":"Try some squats today."}',
      '{"body":"Have a glass of water and stretch."}',
      '{"body":"Open Today when it suits you 🔥"}', // not a permitted emoji
      '{"body":"Open Today 💪 when it suits you."}', // permitted emoji, but not trailing
      '{"body":"Open Today when it suits you 💪💪"}', // more than one
      '{"body":"You should open Today now."}',
    ];
    for (const reply of [...bad, 'error', 500, 429] as const) {
      const p = provider(reply);
      const r = await writeCopy({ env: env(), fetch: p.fetch }, 'workout_reminder', 'en', AI_OK, 3000);
      expect([r.source, r.body], String(reply)).toEqual(['fallback', SHARED_EN['push.coachWorkout.body']]);
      expect(p.calls.length, String(reply)).toBe(1); // one attempt, no retries
    }
    expect(COPY_MAX_CODE_POINTS).toBe(140);
    for (const bad of ['Gerðu nokkrar hnébeygjur í dag.', 'Borðaðu meira prótein í kvöld.', 'Opnaðu Í dag þegar þér hentar 🙂', 'Þú slepptir æfingu í gær.']) {
      expect(validateCopy(JSON.stringify({ body: bad }), 'is', 'workout_reminder'), bad).toBeNull();
    }
    const started = Date.now();
    const slow = provider('timeout');
    const r = await writeCopy({ env: env(), fetch: slow.fetch }, 'food_unlogged', 'is', AI_OK, 1300);
    expect([r.source, r.body]).toEqual(['fallback', SHARED_IS['push.coachFood.body']]);
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('zero model calls without AI enabled, when paused, without consent for the configured provider, without the scope, or without budget', async () => {
    const cases: [CoachKind, unknown, Record<string, string>?, number?][] = [
      ['workout_reminder', null],
      ['workout_reminder', { ...AI_OK, enabled: false }],
      ['workout_reminder', { ...AI_OK, paused: true }],
      ['workout_reminder', { ...AI_OK, consentVersion: '2026-10-29' }], // consented for Anthropic, OpenAI configured
      ['workout_reminder', { ...AI_OK, consentAt: null }],
      ['missed_nudge', { ...AI_OK, training: false }],
      ['food_unlogged', { ...AI_OK, nutrition: false }],
      ['workout_reminder', AI_OK, { OPENAI_API_KEY: '' }],
      ['workout_reminder', AI_OK, { PUSH_AI_COPY: 'off' }],
      ['workout_reminder', AI_OK, { PUSH_AI_COPY: '' }], // not enabled yet (the default)
      ['workout_reminder', AI_OK, {}, 500],
    ];
    for (const [kind, ai, over, budget] of cases) {
      const p = provider('{"body":"Open Today when it suits you."}');
      const r = await writeCopy({ env: env(over), fetch: p.fetch }, kind, 'en', ai as never, budget ?? 3000);
      expect(p.calls, JSON.stringify([kind, ai, over])).toHaveLength(0);
      expect(r.body).toBe(fallbackBody(kind, 'en'));
    }
  });

  it('a language change or consent revocation during generation sends the current-language fallback instead of the stale copy', async () => {
    const p = provider('{"body":"Open Today whenever it suits you."}');
    const m = memoryDb([[coachJob()]], (_id, st) => (st === 'prepare' ? { status: 'ok', language: 'en', ai: AI_OK } : { status: 'ok', language: 'is', ai: AI_OK }));
    const s = service({});
    await runPushSend({ db: m.db, send: s.send, now: () => NOW, copy: { env: env(), fetch: p.fetch } });
    expect(sentBody(s).body).toBe(SHARED_IS['push.coachWorkout.body']);
    expect(m.finished).toMatchObject([{ copy: { language: 'is', source: 'fallback' } }]);
    const p2 = provider('{"body":"Open Today whenever it suits you."}');
    const m2 = memoryDb([[coachJob()]], (_id, st) => ({ status: 'ok', language: 'en', ai: st === 'prepare' ? AI_OK : { ...AI_OK, enabled: false } }));
    const s2 = service({});
    await runPushSend({ db: m2.db, send: s2.send, now: () => NOW, copy: { env: env(), fetch: p2.fetch } });
    expect(sentBody(s2).body).toBe(SHARED_EN['push.coachWorkout.body']);
  });

  it('a retried event reuses its cached copy (one generation per event), unless the language no longer matches', async () => {
    const p = provider('{"body":"Something new."}');
    const cached = { body: 'Open Today whenever it suits you.', language: 'en', source: 'ai' };
    const s = service({});
    await processCoachJob({ db: memoryDb([], () => ({ status: 'ok', language: 'en', ai: AI_OK })).db, send: s.send, now: () => NOW, copy: { env: env(), fetch: p.fetch } }, coachJob({ copy: cached }), 10_000);
    expect(p.calls).toHaveLength(0);
    expect(sentBody(s).body).toBe(cached.body);
    const s2 = service({});
    await processCoachJob({ db: memoryDb([], () => ({ status: 'ok', language: 'is', ai: AI_OK })).db, send: s2.send, now: () => NOW, copy: { env: env(), fetch: p.fetch } }, coachJob({ copy: cached }), 10_000);
    // The language changed since the attempt: the new language's approved fallback, never a second generation.
    expect(sentBody(s2).body).toBe(SHARED_IS['push.coachWorkout.body']);
    expect(p.calls).toHaveLength(0);
  });

  it('PUSH_AI_COPY off also stops cached generated text and the final dispatch from using AI wording', async () => {
    const cached = { body: 'Open Today whenever it suits you.', language: 'en', source: 'ai' };
    for (const flag of ['off', '']) {
      const s = service({});
      const p = provider('{"body":"Open Today whenever it suits you."}');
      await processCoachJob({ db: memoryDb([], () => ({ status: 'ok', language: 'en', ai: AI_OK })).db, send: s.send, now: () => NOW, copy: { env: env({ PUSH_AI_COPY: flag }), fetch: p.fetch } }, coachJob({ copy: cached }), 10_000);
      expect(sentBody(s).body).toBe(SHARED_EN['push.coachWorkout.body']);
      expect(p.calls).toHaveLength(0);
    }
    // Without copy deps at all (older deploy wiring) cached AI text isn't used either.
    const s = service({});
    await processCoachJob({ db: memoryDb([], () => ({ status: 'ok', language: 'en', ai: AI_OK })).db, send: s.send, now: () => NOW }, coachJob({ copy: cached }), 10_000);
    expect(sentBody(s).body).toBe(SHARED_EN['push.coachWorkout.body']);
  });

  it('one generation per event is durable: the attempt is stored with the final check, so a failed check and the retry make one model call', async () => {
    const p = provider('{"body":"Open Today whenever it suits you."}');
    for (const verdict of [{ status: 'lost' }, { status: 'discard', reason: 'snoozed' }, { status: 'deferred', fireAt: '2026-11-02T14:00:00Z' }] as CheckResult[]) {
      const m = memoryDb([], (_id, st) => (st === 'dispatch' ? verdict : { status: 'ok', language: 'en', ai: AI_OK }));
      const s = service({});
      const r = await processCoachJob({ db: m.db, send: s.send, now: () => NOW, copy: { env: env(), fetch: p.fetch } }, coachJob(), 10_000);
      expect(r.status).toBe('skipped');
      expect(s.sent).toHaveLength(0);
      expect(m.stored).toEqual([{ body: 'Open Today whenever it suits you.', language: 'en', source: 'ai' }]);
    }
    expect(p.calls).toHaveLength(3); // one per event above
    // The retry of the last event sees the stored attempt (push_claim_due_v2 returns it as job.copy): no second call.
    const s = service({});
    await processCoachJob({ db: memoryDb([], () => ({ status: 'ok', language: 'en', ai: AI_OK })).db, send: s.send, now: () => NOW, copy: { env: env(), fetch: p.fetch } }, coachJob({ copy: { body: 'Open Today whenever it suits you.', language: 'en', source: 'ai' } }), 10_000);
    expect(p.calls).toHaveLength(3);
    expect(sentBody(s).body).toBe('Open Today whenever it suits you.');
    // A fallback attempt is stored too, so a later retry never calls the model either.
    const q = provider('{"body":"Too many calories."}');
    const m = memoryDb([], (_id, st) => (st === 'dispatch' ? { status: 'lost' } : { status: 'ok', language: 'is', ai: AI_OK }));
    await processCoachJob({ db: m.db, send: service({}).send, now: () => NOW, copy: { env: env(), fetch: q.fetch } }, coachJob(), 10_000);
    expect(m.stored).toEqual([{ body: SHARED_IS['push.coachWorkout.body'], language: 'is', source: 'fallback' }]);
  });
});

describe('coach reminders: push model defaults and the narrow emoji policy', () => {
  it('push copy has its own OpenAI defaults: changing the chat model never changes reminder copy', () => {
    expect(DEFAULT_OPENAI_MODEL).toBe('gpt-5.4');
    expect(DEFAULT_PUSH_OPENAI_MODEL).toBe('gpt-5.4-mini');
    expect(DEFAULT_PUSH_REASONING_EFFORT).toBe('none');
    for (const chat of [undefined, 'gpt-5.4', 'gpt-5.5', 'gpt-5-mini', 'gpt-4.1-mini']) {
      const e = (k: string) => ({ OPENAI_API_KEY: 'k', ...(chat ? { OPENAI_MODEL: chat } : {}) })[k];
      const p = resolveProvider(e)!;
      expect(p.model).toBe(chat ?? 'gpt-5.4');
      expect(resolvePushModel(e, p), String(chat)).toEqual({ model: 'gpt-5.4-mini', reasoningEffort: 'none', reasoningAllowance: 0 });
    }
    // The chat effort env does not leak into push either.
    const e2 = (k: string) => ({ OPENAI_API_KEY: 'k', OPENAI_REASONING_EFFORT: 'high', OPENAI_REASONING_TOKEN_ALLOWANCE: '8000' })[k];
    expect(resolvePushModel(e2, resolveProvider(e2)!)).toEqual({ model: 'gpt-5.4-mini', reasoningEffort: 'none', reasoningAllowance: 0 });
  });

  it('explicit push overrides still apply; non-reasoning models get no reasoning fields; the allowance never exceeds 512', () => {
    const r = (over: Record<string, string>) => {
      const e = (k: string) => ({ OPENAI_API_KEY: 'k', ...over })[k];
      return resolvePushModel(e, resolveProvider(e)!);
    };
    expect(r({ PUSH_COPY_MODEL: 'gpt-5.5' })).toEqual({ model: 'gpt-5.5', reasoningEffort: 'none', reasoningAllowance: 0 });
    expect(r({ PUSH_COPY_REASONING_EFFORT: 'low' })).toEqual({ model: 'gpt-5.4-mini', reasoningEffort: 'low', reasoningAllowance: 512 });
    expect(r({ PUSH_COPY_REASONING_EFFORT: 'off' })).toEqual({ model: 'gpt-5.4-mini', reasoningEffort: undefined, reasoningAllowance: 0 });
    expect(r({ PUSH_COPY_REASONING_EFFORT: 'low', PUSH_COPY_REASONING_TOKEN_ALLOWANCE: '256' })).toMatchObject({ reasoningAllowance: 256 });
    expect(r({ PUSH_COPY_REASONING_EFFORT: 'low', PUSH_COPY_REASONING_TOKEN_ALLOWANCE: '4000' })).toMatchObject({ reasoningAllowance: 512 });
    // An explicit allowance still wins with "none" (capped at 512).
    expect(r({ PUSH_COPY_REASONING_TOKEN_ALLOWANCE: '128' })).toEqual({ model: 'gpt-5.4-mini', reasoningEffort: 'none', reasoningAllowance: 128 });
    expect(r({ PUSH_COPY_MODEL: 'gpt-4.1-mini', PUSH_COPY_REASONING_EFFORT: 'low' })).toEqual({ model: 'gpt-4.1-mini', reasoningEffort: undefined, reasoningAllowance: 0 });
    // Anthropic: the push override or the configured model, never reasoning fields.
    const a = (k: string) => ({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'claude-sonnet-5-5' })[k];
    expect(resolvePushModel(a, resolveProvider(a)!)).toEqual({ model: 'claude-sonnet-5-5', reasoningEffort: undefined, reasoningAllowance: 0 });
  });

  it('"none" (the default) and "minimal" are mapped to what each model accepts', () => {
    const r = (over: Record<string, string>) => {
      const e = (k: string) => ({ OPENAI_API_KEY: 'k', ...over })[k];
      return resolvePushModel(e, resolveProvider(e)!);
    };
    // The original GPT-5 family rejects "none" and gets "minimal" (with the 512 allowance).
    for (const m of ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5-mini-2025-08-07']) {
      expect(r({ PUSH_COPY_MODEL: m }), m).toEqual({ model: m, reasoningEffort: 'minimal', reasoningAllowance: 512 });
    }
    // gpt-5.1+ reject "minimal": an explicit "minimal" becomes "none".
    for (const m of ['gpt-5.1', 'gpt-5.4-mini', 'gpt-5.5']) {
      expect(r({ PUSH_COPY_MODEL: m }), m).toEqual({ model: m, reasoningEffort: 'none', reasoningAllowance: 0 });
      expect(r({ PUSH_COPY_MODEL: m, PUSH_COPY_REASONING_EFFORT: 'minimal' }), m).toEqual({ model: m, reasoningEffort: 'none', reasoningAllowance: 0 });
    }
    // Models that take neither get "low".
    for (const m of ['gpt-5-pro', 'o4-mini']) {
      expect(r({ PUSH_COPY_MODEL: m }), m).toEqual({ model: m, reasoningEffort: 'low', reasoningAllowance: 512 });
      expect(r({ PUSH_COPY_MODEL: m, PUSH_COPY_REASONING_EFFORT: 'minimal' }).reasoningEffort, m).toBe('low');
    }
    expect(r({ PUSH_COPY_MODEL: 'gpt-5.1', PUSH_COPY_REASONING_EFFORT: 'off' })).toMatchObject({ reasoningEffort: undefined, reasoningAllowance: 0 });
  });

  it('override-only payload: PUSH_COPY_MODEL=gpt-5-mini sends "minimal", never the "none" it rejects', async () => {
    const p = provider('{"body":"Open Today when it suits you."}');
    const r = await writeCopy({ env: env({ OPENAI_MODEL: '', PUSH_COPY_MODEL: 'gpt-5-mini' }), fetch: p.fetch }, 'workout_reminder', 'en', AI_OK, 3000);
    expect(r.source).toBe('ai');
    expect(p.calls[0].body).toMatchObject({ model: 'gpt-5-mini', reasoning_effort: 'minimal', max_completion_tokens: 160 + 512 });
  });

  it('the request uses the push defaults (gpt-5.4-mini, none, 160 tokens) and carries the reminder kind', async () => {
    for (const [over, model, effort, max] of [
      [{ OPENAI_MODEL: '' }, 'gpt-5.4-mini', 'none', 160],
      [{ OPENAI_MODEL: 'gpt-5.4' }, 'gpt-5.4-mini', 'none', 160],
      [{ PUSH_COPY_REASONING_EFFORT: 'low' }, 'gpt-5.4-mini', 'low', 160 + 512],
      [{ PUSH_COPY_MODEL: 'gpt-4.1-mini' }, 'gpt-4.1-mini', undefined, 160],
    ] as const) {
      const p = provider('{"body":"Open Today when it suits you."}');
      const r = await writeCopy({ env: env(over), fetch: p.fetch }, 'workout_reminder', 'en', AI_OK, 3000);
      expect(r.source).toBe('ai');
      expect(p.calls[0].body.model).toBe(model);
      expect(p.calls[0].body.reasoning_effort).toBe(effort);
      expect(p.calls[0].body.max_completion_tokens).toBe(max);
      const user = JSON.parse((p.calls[0].body.messages as { role: string; content: string }[]).find((x) => x.role === 'user')!.content);
      expect(user).toMatchObject({ kind: 'workout_reminder', tone: 'supportive' });
      expect(user.emoji).toMatch(/💪 or 🙌/);
    }
    for (const kind of ['missed_nudge', 'food_unlogged'] as const) {
      const p = provider('{"body":"Open Today when it suits you."}');
      await writeCopy({ env: env(), fetch: p.fetch }, kind, 'en', AI_OK, 3000);
      const user = JSON.parse((p.calls[0].body.messages as { role: string; content: string }[]).find((x) => x.role === 'user')!.content);
      expect(user).toMatchObject({ kind, emoji: 'none' });
    }
    // The system prompt no longer has a blanket "no emoji" rule that contradicts the workout allowance.
    const p = provider('{"body":"Open Today when it suits you."}');
    await writeCopy({ env: env(), fetch: p.fetch }, 'workout_reminder', 'en', AI_OK, 3000);
    const system = (p.calls[0].body.messages as { role: string; content: string }[]).find((x) => x.role === 'system')!.content;
    expect(system).not.toMatch(/no emoji/i);
    expect(system).toMatch(/Tone: lightly upbeat, warm, supportive and low-pressure, like a friendly nudge; never hype\./);
    expect(system).toMatch(/workout_reminder.*💪 or 🙌/);
  });

  it('workout_reminder allows exactly one trailing 💪 or 🙌; missed and food nudges allow none', () => {
    const v = (body: string, kind: CoachKind, lang: 'en' | 'is' = 'en') => validateCopy(JSON.stringify({ body }), lang, kind);
    expect(v('Your workout is ready in Today when it suits you 💪', 'workout_reminder')).toBe('Your workout is ready in Today when it suits you 💪');
    expect(v('Your workout is ready in Today when it suits you. 🙌', 'workout_reminder')).toBe('Your workout is ready in Today when it suits you. 🙌');
    expect(v('Æfing dagsins bíður þín í Í dag þegar þér hentar 💪', 'workout_reminder', 'is')).toBe('Æfing dagsins bíður þín í Í dag þegar þér hentar 💪');
    for (const bad of [
      'Your workout is ready in Today 🔥',
      'Your workout is ready in Today 💪🙌',
      '💪 Your workout is ready in Today.',
      'Your 💪 workout is ready in Today.',
      'Your workout is ready 🙂',
      '💪',
      'You skipped yesterday 💪', // the trailing emoji never exempts forbidden content
    ]) expect(v(bad, 'workout_reminder'), bad).toBeNull();
    for (const kind of ['missed_nudge', 'food_unlogged'] as const) {
      expect(v('Open the app whenever it suits you.', kind)).toBe('Open the app whenever it suits you.');
      for (const e of ['💪', '🙌', '🔥']) expect(v(`Open the app whenever it suits you ${e}`, kind), `${kind} ${e}`).toBeNull();
    }
  });

  it('the trailing emoji counts toward the 140 code-point limit', () => {
    const base = 'Open Today when it suits you, your planned session is there and ready. ';
    const text139 = (base + base).slice(0, 138).trimEnd().padEnd(138, 'a');
    expect([...`${text139} 💪`].length).toBe(140);
    expect(validateCopy(JSON.stringify({ body: `${text139} 💪` }), 'en', 'workout_reminder')).toBe(`${text139} 💪`);
    const text140 = `${text139}a`;
    expect([...`${text140} 💪`].length).toBe(141);
    expect(validateCopy(JSON.stringify({ body: text140 }), 'en', 'workout_reminder')).not.toBeNull();
    expect(validateCopy(JSON.stringify({ body: `${text140} 💪` }), 'en', 'workout_reminder')).toBeNull();
  });

  it('cached generated copy is validated against the same per-kind policy at dispatch; consent still applies', () => {
    const withEmoji = { body: 'Your workout is ready in Today when it suits you 💪', language: 'en', source: 'ai' };
    expect(finalizeCopy('workout_reminder', withEmoji, 'en', true)).toMatchObject({ body: withEmoji.body, source: 'ai' });
    expect(finalizeCopy('workout_reminder', withEmoji, 'en', false)).toMatchObject({ body: SHARED_EN['push.coachWorkout.body'], source: 'fallback' });
    expect(finalizeCopy('missed_nudge', withEmoji, 'en', true)).toMatchObject({ body: SHARED_EN['push.coachMissed.body'], source: 'fallback' });
    expect(finalizeCopy('food_unlogged', withEmoji, 'en', true)).toMatchObject({ body: SHARED_EN['push.coachFood.body'], source: 'fallback' });
    const fire = { ...withEmoji, body: 'Your workout is ready in Today 🔥' };
    expect(finalizeCopy('workout_reminder', fire, 'en', true)).toMatchObject({ source: 'fallback' });
  });

  it('a generated missed or food nudge with an emoji falls back to the approved text', async () => {
    for (const [kind, key] of [['missed_nudge', 'push.coachMissed.body'], ['food_unlogged', 'push.coachFood.body']] as const) {
      const p = provider('{"body":"Open the app whenever it suits you 💪"}');
      const r = await writeCopy({ env: env(), fetch: p.fetch }, kind, 'en', AI_OK, 3000);
      expect([r.source, r.body, r.reason]).toEqual(['fallback', SHARED_EN[key], 'invalid']);
    }
    const p = provider('{"body":"Open the app whenever it suits you 💪"}');
    const r = await writeCopy({ env: env(), fetch: p.fetch }, 'workout_reminder', 'en', AI_OK, 3000);
    expect([r.source, r.body]).toEqual(['ai', 'Open the app whenever it suits you 💪']);
  });
});

describe('coach reminders: quiet hours at the final check', () => {
  it('generation starts at 21:59:59 (outside) and dispatch is at 22:00:01: the server defers it and nothing is sent', async () => {
    let t = Date.parse('2026-11-02T20:59:59Z'); // 21:59:59 Oslo
    const m = memoryDb([], (_id, st) => {
      if (st === 'prepare') return { status: 'ok', language: 'en', ai: null };
      t = Date.parse('2026-11-02T21:00:01Z'); // the copy took two seconds: 22:00:01 Oslo
      return { status: 'deferred', fireAt: '2026-11-03T06:00:00.000Z' };
    });
    const s = service({});
    const r = await processCoachJob({ db: m.db, send: s.send, now: () => new Date(t) }, coachJob({ expiresAt: '2026-11-03T23:00:00.000Z' }), 10_000);
    expect(m.checked.map((c) => c[2])).toEqual(['prepare', 'dispatch']);
    expect(r).toEqual({ id: 'w', token: 'tok-w', status: 'skipped', reason: 'deferred' });
    expect(s.sent).toHaveLength(0);
  });

  it('quiet hours changed by the user while processing: the claim-time settings said "send", the current ones defer it', async () => {
    const m = memoryDb([], (_id, st) => (st === 'prepare' ? { status: 'ok', language: 'en' } : { status: 'deferred', fireAt: '2026-11-02T15:00:00.000Z' }));
    const s = service({});
    // Claim-time prefs: quiet hours off. The server's dispatch check uses the new 12:00–16:00 window.
    const r = await processCoachJob({ db: m.db, send: s.send, now: () => NOW }, coachJob({ prefs: { timeZone: 'Europe/Oslo', quietStart: '00:00', quietEnd: '00:00' } }), 10_000);
    expect(r).toMatchObject({ status: 'skipped', reason: 'deferred' });
    expect(s.sent).toHaveLength(0);
  });
});

describe('coach reminders: generation stays single when saving the attempt fails', () => {
  it('the dispatch RPC is rejected after the model ran → released; the retry is told an attempt happened and sends the fallback without a second model call', async () => {
    const p = provider('{"body":"Open Today whenever it suits you."}');
    let marker = false; // what push_check's attempt marker (copy_attempted_at) records on the server
    const prepare = (): CheckResult => {
      const r: CheckResult = { status: 'ok', language: 'en', ai: AI_OK, copyAttempted: marker };
      marker = true;
      return r;
    };
    const failing = memoryDb([], (_id, st) => {
      if (st === 'prepare') return prepare();
      throw new Error('network: the save never reached the database');
    });
    const s1 = service({});
    const first = await processCoachJob({ db: failing.db, send: s1.send, now: () => NOW, copy: { env: env(), fetch: p.fetch } }, coachJob(), 10_000);
    expect(first).toEqual({ id: 'w', token: 'tok-w', status: 'release' });
    expect(s1.sent).toHaveLength(0);
    expect(p.calls).toHaveLength(1);
    // Reclaimed with no stored copy (the save never happened).
    const ok = memoryDb([], (_id, st) => (st === 'prepare' ? prepare() : { status: 'ok', language: 'en', ai: AI_OK }));
    const s2 = service({});
    await processCoachJob({ db: ok.db, send: s2.send, now: () => NOW, copy: { env: env(), fetch: p.fetch } }, coachJob({ copy: null }), 10_000);
    expect(p.calls).toHaveLength(1); // still one model call for the event
    expect(sentBody(s2).body).toBe(SHARED_EN['push.coachWorkout.body']);
    expect(ok.stored).toEqual([{ body: SHARED_EN['push.coachWorkout.body'], language: 'en', source: 'fallback' }]);
  });
});

describe('live evaluation judge verdicts (strict)', () => {
  const all = { guilt: false, compensation: false, exercise_prescription: false, food_prescription: false, target_or_measurement: false, claims_skipped: false, language_ok: true, supportive: true };
  it('accepts only a complete verdict with eight booleans', () => {
    expect(judgeProblems(JSON.stringify(all))).toEqual([]);
    expect(judgeProblems(JSON.stringify({ ...all, guilt: true, supportive: false }))).toEqual(['guilt', 'not_supportive']);
    expect(judgeProblems(JSON.stringify({ ...all, language_ok: false }))).toEqual(['language']);
  });
  it('rejects incomplete, extra, string-valued, malformed, prose-wrapped and truncated replies', () => {
    expect(judgeProblems('{"language_ok":true,"supportive":true}')).toEqual(['judge_incomplete']);
    expect(judgeProblems(JSON.stringify({ ...all, extra: false }))).toEqual(['judge_incomplete']);
    expect(judgeProblems(JSON.stringify({ ...all, guilt: 'false' }))).toEqual(['judge_not_boolean']);
    expect(judgeProblems(JSON.stringify({ ...all, supportive: 'true' }))).toEqual(['judge_not_boolean']);
    expect(judgeProblems('Here you go: ' + JSON.stringify(all))).toEqual(['judge_malformed']);
    expect(judgeProblems('{"guilt": false, "compensation": fa')).toEqual(['judge_malformed']);
    expect(judgeProblems('[]')).toEqual(['judge_malformed']);
    expect(judgeProblems(JSON.stringify(all), true)).toEqual(['judge_truncated']);
  });
});
