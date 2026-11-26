#!/usr/bin/env node
/**
 * OPT-IN deployed smoke test for the training assistant stream (roadmap item 10). Costs a few provider calls.
 *
 *   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=<publishable key> LC_MEMBER=email:password \
 *     node tests/live/ai-sse-smoke.mjs
 *
 * The LC_MEMBER test account must have the training assistant switched on and agreed (any sharing). Checks, against
 * the deployed ai-coach function and database:
 *  1. status advertises protocol.stream (and protocol.cancel once 20261130000001 is applied);
 *  2. a full stream: SSE headers, status → text_delta… → complete; the deltas join to exactly the stored reply;
 *  3. disconnect: the client drops the stream after the first status event; the work still finishes (request_status
 *     reaches 'succeeded' with the SAME id) and a JSON replay returns it as a duplicate without another charge;
 *  4. Stop (when supported): cancel during the stream ends in 'cancelled' (or success won → 'complete'); the id can't
 *     be reused; a cancel before the send creates a tombstone so that send is refused (request_cancelled).
 * Without the env it prints BLOCKED and exits 2 (never a pass). Uses a synthetic test account only.
 */
import { build } from 'esbuild';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const URL_ = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
const MEMBER = process.env.LC_MEMBER || '';
if (!URL_ || !KEY || !MEMBER.includes(':')) {
  console.log('BLOCKED: set SUPABASE_URL, SUPABASE_ANON_KEY and LC_MEMBER=email:password (a synthetic test account).');
  process.exit(2);
}
const out = await build({ entryPoints: [path.join(ROOT, 'src/backend/sseParser.ts')], bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent' });
const { createSseParser } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [email, password] = [MEMBER.slice(0, MEMBER.indexOf(':')), MEMBER.slice(MEMBER.indexOf(':') + 1)];
const auth = await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: KEY, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
const token = (await auth.json()).access_token;
if (!token) {
  console.log('BLOCKED: could not sign in the test account.');
  process.exit(2);
}
const headers = (accept = 'application/json') => ({ authorization: `Bearer ${token}`, apikey: KEY, 'content-type': 'application/json', accept });
const call = async (body) => {
  const r = await fetch(`${URL_}/functions/v1/ai-coach`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
/** Stream a send; `stopAfter(ev)` returning true aborts the connection (disconnect). */
async function stream(id, text, stopAfter = () => false) {
  const ctl = new AbortController();
  const res = await fetch(`${URL_}/functions/v1/ai-coach`, { method: 'POST', headers: headers('text/event-stream'), body: JSON.stringify({ action: 'send', id, text, mode: 'chat', stream: true }), signal: ctl.signal });
  const events = [];
  const parser = createSseParser({ onEvent: (e) => events.push({ event: e.event, data: JSON.parse(e.data) }) });
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(value);
      if (events.some((e) => ['complete', 'error', 'cancelled'].includes(e.event))) break;
      if (events.length && stopAfter(events.at(-1))) {
        ctl.abort();
        break;
      }
    }
  } catch (e) {
    if (e?.name !== 'AbortError') throw e;
  }
  return { res, events };
}

const status = await call({ action: 'status' });
const proto = status.body?.protocol ?? {};
check('status advertises streaming', proto.stream === 1, JSON.stringify(proto));
const canCancel = proto.cancel === 1;

// 2. full stream
{
  const id = randomUUID();
  const { res, events } = await stream(id, 'Smoke test: reply with one short sentence about rest days.');
  check('SSE content type', /text\/event-stream; charset=utf-8/i.test(res.headers.get('content-type') ?? ''), res.headers.get('content-type'));
  check('Cache-Control no-store, no-transform', /no-store/.test(res.headers.get('cache-control') ?? '') && /no-transform/.test(res.headers.get('cache-control') ?? ''));
  const complete = events.find((e) => e.event === 'complete');
  check('status before text, complete last', events[0]?.event === 'status' && events.at(-1)?.event === 'complete', events.map((e) => e.event).join(','));
  const joined = events.filter((e) => e.event === 'text_delta').map((e) => e.data.text).join('');
  check('deltas join to the stored reply', !!complete && joined === complete.data.reply.content);
}

// 3. disconnect after the first status event
{
  const id = randomUUID();
  await stream(id, 'Smoke test: reply with one short sentence about sleep.', (e) => e.event === 'status');
  let state = 'running';
  for (let i = 0; i < 75 && state !== 'succeeded'; i++) {
    await sleep(2000);
    const st = await call({ action: 'request_status', id });
    state = st.status === 200 ? st.body.state : st.status === 501 ? 'unsupported' : `http_${st.status}`;
    if (state === 'unsupported') {
      // Without the cancellation migration: the replay of the same id waits (in_progress) and then returns the reply.
      const r = await call({ action: 'send', id, text: 'Smoke test: reply with one short sentence about sleep.', mode: 'chat' });
      state = r.status === 200 ? 'succeeded' : 'running';
    }
  }
  check('detached work finished on the server (same id)', state === 'succeeded', state);
  const before = (await call({ action: 'status' })).body?.usage?.requests;
  const replay = await call({ action: 'send', id, text: 'Smoke test: reply with one short sentence about sleep.', mode: 'chat' });
  const after = (await call({ action: 'status' })).body?.usage?.requests;
  check('replay returns the stored exchange as a duplicate', replay.status === 200 && replay.body.duplicate === true);
  check('no second charge for the replay', before === after, `${before} → ${after}`);
}

// 4. Stop
if (canCancel) {
  const id = randomUUID();
  let sent = false;
  const p = stream(id, 'Smoke test: list three warm-up ideas.', () => false);
  await sleep(300);
  const c = await call({ action: 'cancel', id });
  sent = c.status === 200;
  const { events } = await p;
  const last = events.at(-1)?.event;
  check('cancel acknowledged', sent && ['cancelled', 'cancel_requested', 'succeeded'].includes(c.body.state), c.body.state);
  check('stream ends cancelled (or success won)', last === 'cancelled' || last === 'complete', last);
  if (last === 'cancelled') {
    const again = await call({ action: 'send', id, text: 'x', mode: 'chat' });
    check('a stopped id is not reused', again.status === 409 && again.body.code === 'request_cancelled', again.body.code);
  }
  const t = randomUUID();
  await call({ action: 'cancel', id: t });
  const late = await call({ action: 'send', id: t, text: 'x', mode: 'chat' });
  check('cancel before the send: the send never starts', late.status === 409 && late.body.code === 'request_cancelled', late.body.code);
} else console.log('SKIP  Stop checks (protocol.cancel not advertised: apply 20261130000001_ai_cancellation.sql)');

const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\nFAILURES: ${failed}` : `\nALL PASSED: ${results.length}`);
process.exit(failed ? 1 : 0);
