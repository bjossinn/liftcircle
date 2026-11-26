#!/usr/bin/env node
/**
 * Push notification database tests: `node tests/rls/push-run.mjs` (npm run test:push-db)
 *
 * Same approach as tests/rls/ai-run.mjs: a throwaway PostgreSQL 16 cluster, tests/rls/supabase-stub.sql, then EVERY
 * migration applied in order as the non-superuser `postgres` role, requests simulated with set local role + JWT claims.
 * Covers: RLS/grants on push_subscriptions / push_prefs / push_jobs (owner-only, anon nothing), RPC validation,
 * replace_scheduled_jobs idempotency, no scheduling for other users, the notifications → push trigger with burst
 * coalescing, service-only push-send RPCs, 410 handling, cleanup, and FOR UPDATE SKIP LOCKED across two connections.
 *
 * Env: PG_BIN (default /usr/lib/postgresql/16/bin), PUSH_PG_PORT (default 54340), RLS_KEEP=1 keeps the cluster dir.
 */
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = process.env.PG_BIN || '/usr/lib/postgresql/16/bin';
const PORT = Number(process.env.PUSH_PG_PORT || 54340);
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

/* ------------------------------------------------------------ cluster lifecycle (as in run.mjs) */
let tmp;
function sh(cmd, args, { allowFail = false } = {}) {
  const full = isRoot ? ['runuser', ['-u', 'postgres', '--', cmd, ...args]] : [cmd, args];
  const r = spawnSync(full[0], full[1], { encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} failed (${r.status}): ${r.stderr || r.stdout || r.error}`);
  return r;
}
function startCluster() {
  if (!fs.existsSync(path.join(BIN, 'initdb'))) throw new Error(`PostgreSQL binaries not found in ${BIN} (set PG_BIN).`);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-push-'));
  if (isRoot) {
    if (spawnSync('id', ['-u', 'postgres']).status !== 0) throw new Error('Running as root but no `postgres` OS user exists.');
    spawnSync('chown', ['-R', 'postgres', tmp]);
    fs.chmodSync(tmp, 0o755);
  }
  const data = path.join(tmp, 'data');
  sh(path.join(BIN, 'initdb'), ['-D', data, '-U', 'supabase_admin', '-A', 'trust', '-E', 'UTF8', '--locale=C', '--no-sync']);
  sh(path.join(BIN, 'pg_ctl'), ['-D', data, '-l', path.join(tmp, 'server.log'), '-w', '-t', '30', 'start', '-o',
    `-p ${PORT} -k ${tmp} -c listen_addresses=localhost -c fsync=off -c synchronous_commit=off -c full_page_writes=off`]);
}
function stopCluster() {
  if (!tmp) return;
  sh(path.join(BIN, 'pg_ctl'), ['-D', path.join(tmp, 'data'), '-m', 'immediate', '-w', 'stop'], { allowFail: true });
  if (!process.env.RLS_KEEP) fs.rmSync(tmp, { recursive: true, force: true });
  else console.log(`(cluster kept in ${tmp})`);
}

/* ------------------------------------------------------------ helpers */
const results = [];
let current = '';
async function test(area, name, fn) {
  current = `${area} ${name}`;
  try {
    await fn();
    results.push({ area, name, ok: true });
  } catch (e) {
    results.push({ area, name, ok: false, err: e?.message ?? String(e) });
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function eq(a, b, msg) {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg}: expected ${sb}, got ${sa}`);
}

let admin;
let app;
const U = { alice: randomUUID(), bob: randomUUID(), eve: randomUUID(), carol: randomUUID(), dave: randomUUID() };

async function as(actor, sql, params = []) {
  await app.query('begin');
  try {
    if (actor === 'anon') {
      await app.query('set local role anon');
      await app.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'anon' })]);
    } else if (actor === 'service') {
      await app.query('set local role service_role');
      await app.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'service_role' })]);
    } else {
      await app.query('set local role authenticated');
      await app.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: U[actor] ?? actor, role: 'authenticated', aud: 'authenticated' })]);
    }
    const r = await app.query(sql, params);
    await app.query('commit');
    return { rows: r.rows, rowCount: r.rowCount };
  } catch (error) {
    await app.query('rollback');
    return { error, rows: [], rowCount: 0 };
  }
}
/** rpc(actor, 'fn', { p_x: [value, 'jsonb'] | value }) */
async function rpc(actor, fn, args = {}) {
  const keys = Object.keys(args);
  const params = keys.map((k) => {
    const v = Array.isArray(args[k]) && args[k].length === 2 && typeof args[k][1] === 'string' && args[k][1].startsWith('::') ? args[k][0] : args[k];
    return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
  });
  const casts = keys.map((k) => (Array.isArray(args[k]) && typeof args[k][1] === 'string' && args[k][1].startsWith('::') ? args[k][1] : ''));
  const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}${casts[i]}`).join(', ')}) as v`;
  const r = await as(actor, sql, params);
  return r.error ? { error: r.error } : { value: r.rows[0]?.v };
}
const J = (v) => [v, '::jsonb'];
const sc = (o) => ['profile', 'training', 'measurements', 'nutrition'].map((k) => `${k}:${o?.[k]}`).join(',');
function ok(r, what) {
  if (r.error) throw new Error(`${what}: unexpected error: ${r.error.message}`);
  return 'value' in r ? r.value : r.rows;
}
function fails(r, what, pattern) {
  if (!r.error) throw new Error(`${what}: expected an error but it succeeded`);
  if (pattern && !pattern.test(`${r.error.message} ${r.error.code} ${r.error.hint ?? ''} ${r.error.detail ?? ''}`)) {
    throw new Error(`${what}: wrong error "${r.error.message}" (${r.error.code}, hint ${r.error.hint})`);
  }
}
async function visible(actor, sql, params) {
  const r = await as(actor, sql, params);
  return r.error ? -1 : r.rows.length;
}


const job = (key, minutesFromNow, { payload = {}, ...over } = {}) => ({
  dedupeKey: key,
  fireAt: new Date(Date.now() + minutesFromNow * 60_000).toISOString(),
  payload: { title: 'Hard Earned', body: 'Upper A today. Ready for a session?', url: '/', tag: 'workout', ...payload },
  ...over,
});
const SUB = (n) => ({ endpoint: `https://push.example.net/p/${n}`, p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' });
const jobsOf = async (user, extra = '') => (await admin.query(`select * from public.push_jobs where user_id = $1 ${extra} order by created_at, dedupe_key`, [user])).rows;

/* ================================================================= main */
async function main() {
  startCluster();
  admin = new pg.Client({ host: 'localhost', port: PORT, user: 'supabase_admin', database: 'postgres' });
  await admin.connect();
  await admin.query(fs.readFileSync(path.join(ROOT, 'tests/rls/supabase-stub.sql'), 'utf8'));
  app = new pg.Client({ host: 'localhost', port: PORT, user: 'postgres', database: 'postgres' });
  await app.connect();

  const migDir = path.join(ROOT, 'supabase/migrations');
  const migrations = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
  const notices = [];
  app.on('notice', (n) => notices.push(n.message));
  await test('setup', `apply ${migrations.length} migrations as non-superuser postgres (push cron setup is a no-op with a NOTICE)`, async () => {
    assert(migrations.includes('20261101000001_push_notifications.sql'), 'push migration present');
    for (const f of migrations) {
      try {
        await app.query('begin');
        await app.query(fs.readFileSync(path.join(migDir, f), 'utf8'));
        await app.query('commit');
      } catch (e) {
        await app.query('rollback');
        throw new Error(`${f}: ${e.message}${e.position ? ` (at char ${e.position})` : ''}`);
      }
    }
    assert(notices.some((m) => /push: pg_cron and pg_net are not both enabled/.test(m)), `cron NOTICE missing (got ${JSON.stringify(notices.slice(-3))})`);
  });
  if (!results.at(-1).ok) return;

  for (const [name, id] of Object.entries(U)) {
    await admin.query(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())`, [id, `${name}@example.test`]);
    await admin.query(`insert into public.profiles (id, username, display_name) values ($1, $2, $3)`, [id, name, name[0].toUpperCase() + name.slice(1)]);
  }

  await test('setup', 'RLS on the push tables, owner-only SELECT policy, no client write grants, no anon grants, definer functions pinned', async () => {
    const t = ['push_subscriptions', 'push_prefs', 'push_jobs'];
    const r1 = await admin.query(`select relname from pg_class where relname = any($1) and relnamespace = 'public'::regnamespace and relrowsecurity`, [t]);
    eq(r1.rows.map((x) => x.relname).sort(), [...t].sort(), 'RLS enabled');
    const r2 = await admin.query(`select table_name, grantee, privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and table_name = any($1) and grantee in ('anon','authenticated','PUBLIC') and (grantee = 'anon' or privilege_type <> 'SELECT')`, [t]);
    eq(r2.rows, [], 'write or anon grants');
    const r3 = await admin.query(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','private') and p.prosecdef and p.proname like '%push%'
        and (not coalesce(p.proconfig, '{}') && array['search_path=""', 'search_path='] or has_function_privilege('anon', p.oid, 'execute'))`);
    eq(r3.rows.map((x) => x.proname), [], 'push functions missing search_path or anon-executable');
  });

  await test('privileges', 'anon gets nothing: no RPCs, no rows', async () => {
    for (const [fn, args] of [['save_push_subscription', { p: J(SUB(9)) }], ['get_push_prefs', {}], ['set_push_prefs', { p: J({}) }], ['replace_scheduled_jobs', { p_kind: 'workout_reminder', p_jobs: J([]) }], ['cancel_push_job', { p_dedupe_key: 'x' }], ['send_test_push', {}]]) {
      fails(await rpc('anon', fn, args), `anon ${fn}`, /permission denied/);
    }
    for (const t of ['push_subscriptions', 'push_prefs', 'push_jobs']) assert((await visible('anon', `select * from public.${t}`)) <= 0, `anon reads ${t}`);
  });

  await test('privileges', 'push-send RPCs are service-role only (users cannot claim, finish or clean up jobs)', async () => {
    for (const actor of ['alice', 'anon']) {
      fails(await rpc(actor, 'push_claim_due', { p_limit: 10 }), `${actor} claim`, /permission denied/);
      fails(await rpc(actor, 'push_finish', { p_results: J([]) }), `${actor} finish`, /permission denied/);
      fails(await rpc(actor, 'push_subscription_result', { p_endpoint: 'x', p_status: 410 }), `${actor} sub result`, /permission denied/);
      fails(await rpc(actor, 'push_cleanup', {}), `${actor} cleanup`, /permission denied/);
    }
    fails(await as('alice', `select private.push_schedule_cron()`), 'cron setup', /permission denied/);
    eq(ok(await rpc('service', 'push_claim_due', { p_limit: 10 }), 'service claim'), [], 'service can claim (nothing due)');
  });

  /* ------------------------------------------------------------ subscriptions + prefs */
  await test('subscriptions', 'owner-only: save, read own, never another user’s; no direct writes; delete own only', async () => {
    const s = ok(await rpc('alice', 'save_push_subscription', { p: J({ ...SUB(1), userAgent: 'test', userId: U.bob }) }), 'save');
    assert(s.endpoint === SUB(1).endpoint, 'saved');
    eq((await admin.query(`select user_id from public.push_subscriptions where endpoint = $1`, [SUB(1).endpoint])).rows[0].user_id, U.alice, 'owner = caller, body userId ignored');
    ok(await rpc('bob', 'save_push_subscription', { p: J(SUB(2)) }), 'bob save');
    eq(await visible('alice', `select * from public.push_subscriptions`), 1, 'alice sees only hers');
    eq(await visible('bob', `select * from public.push_subscriptions where endpoint = $1`, [SUB(1).endpoint]), 0, 'bob cannot see alice’s');
    fails(await as('alice', `insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, 'https://x.example/1', $2, $3)`, [U.alice, SUB(1).p256dh, SUB(1).auth]), 'direct insert', /permission denied/);
    fails(await as('alice', `update public.push_subscriptions set user_id = $1`, [U.alice]), 'direct update', /permission denied/);
    eq(ok(await rpc('alice', 'delete_push_subscription', { p_endpoint: SUB(2).endpoint }), 'delete other'), false, 'cannot delete bob’s');
    eq((await admin.query(`select count(*)::int n from public.push_subscriptions where endpoint = $1`, [SUB(2).endpoint])).rows[0].n, 1, 'bob’s row kept');
    fails(await rpc('alice', 'save_push_subscription', { p: J({ ...SUB(3), endpoint: 'http://insecure.example/1' }) }), 'non-https', /check constraint|violates/);
  });

  await test('prefs', 'defaults (social off), validated updates, owner-only', async () => {
    const d = ok(await rpc('alice', 'get_push_prefs'), 'get');
    eq(d.kinds, ['workout_reminder', 'rest_over', 'coaching', 'missed_nudge'], 'default kinds');
    eq([d.quietStart, d.quietEnd, d.fixedReminderTime], ['22:00', '07:00', null], 'quiet + fixed defaults');
    const p = ok(await rpc('alice', 'set_push_prefs', { p: J({ fixedReminderTime: '17:30', timeZone: 'Europe/Oslo', kinds: ['workout_reminder', 'rest_over', 'coaching', 'missed_nudge', 'social'] }) }), 'set');
    eq([p.fixedReminderTime, p.timeZone], ['17:30', 'Europe/Oslo'], 'saved');
    fails(await rpc('alice', 'set_push_prefs', { p: J({ kinds: ['spam'] }) }), 'bad kind', /Unknown notification kind/);
    fails(await rpc('alice', 'set_push_prefs', { p: J({ fixedReminderTime: '25:00' }) }), 'bad time', /HH:MM/);
    fails(await rpc('alice', 'set_push_prefs', { p: J({ timeZone: 'Mars/Olympus' }) }), 'bad zone', /time zone/);
    eq(await visible('bob', `select * from public.push_prefs where user_id = $1`, [U.alice]), 0, 'bob cannot read alice’s prefs');
  });

  /* ------------------------------------------------------------ scheduling */
  await test('jobs', 'replace_scheduled_jobs: idempotent by dedupe key, replaces the kind’s future jobs, never touches sent ones', async () => {
    const a = [job('reminder:d1', 60), job('reminder:d2', 120)];
    eq(ok(await rpc('alice', 'replace_scheduled_jobs', { p_kind: 'workout_reminder', p_jobs: J(a) }), 'upload'), 2, 'two');
    const before = await jobsOf(U.alice, `and kind = 'workout_reminder'`);
    ok(await rpc('alice', 'replace_scheduled_jobs', { p_kind: 'workout_reminder', p_jobs: J(a) }), 'same upload');
    const again = await jobsOf(U.alice, `and kind = 'workout_reminder'`);
    eq(again.map((j) => [j.id, j.fire_at.toISOString(), j.cancelled_at]), before.map((j) => [j.id, j.fire_at.toISOString(), j.cancelled_at]), 'unchanged');
    await admin.query(`update public.push_jobs set sent_at = now() where user_id = $1 and dedupe_key = 'reminder:d1'`, [U.alice]);
    ok(await rpc('alice', 'replace_scheduled_jobs', { p_kind: 'workout_reminder', p_jobs: J([job('reminder:d1', 90, { payload: { body: 'changed' } }), job('reminder:d3', 180)]) }), 'replace');
    const rows = Object.fromEntries((await jobsOf(U.alice, `and kind = 'workout_reminder'`)).map((j) => [j.dedupe_key, j]));
    eq(rows['reminder:d1'].payload.body, 'Upper A today. Ready for a session?', 'sent job not rewritten');
    assert(rows['reminder:d2'].cancelled_at, 'd2 not in the new list → cancelled');
    assert(!rows['reminder:d3'].cancelled_at, 'd3 scheduled');
    // Re-adding a cancelled key revives it.
    ok(await rpc('alice', 'replace_scheduled_jobs', { p_kind: 'workout_reminder', p_jobs: J([job('reminder:d2', 120), job('reminder:d3', 180)]) }), 'revive');
    assert(!(await jobsOf(U.alice, `and dedupe_key = 'reminder:d2'`))[0].cancelled_at, 'revived');
    // Other kinds are untouched by a reminder upload.
    ok(await rpc('alice', 'replace_scheduled_jobs', { p_kind: 'missed_nudge', p_jobs: J([job('nudge:d1', 300, { payload: { tag: 'workout' } })]) }), 'nudge');
    ok(await rpc('alice', 'replace_scheduled_jobs', { p_kind: 'workout_reminder', p_jobs: J([]) }), 'clear reminders');
    assert(!(await jobsOf(U.alice, `and dedupe_key = 'nudge:d1'`))[0].cancelled_at, 'nudge kept');
  });

  await test('jobs', 'a user can’t schedule for someone else or schedule server kinds; payloads are validated; past/too-far jobs are skipped', async () => {
    ok(await rpc('bob', 'replace_scheduled_jobs', { p_kind: 'workout_reminder', p_jobs: J([{ ...job('reminder:x', 30), userId: U.alice, user_id: U.alice }]) }), 'bob upload');
    eq((await admin.query(`select user_id from public.push_jobs where dedupe_key = 'reminder:x'`)).rows.map((r) => r.user_id), [U.bob], 'stored for bob only');
    fails(await rpc('alice', 'replace_scheduled_jobs', { p_kind: 'coaching', p_jobs: J([]) }), 'server kind', /Only reminders/);
    fails(await rpc('alice', 'replace_scheduled_jobs', { p_kind: 'test', p_jobs: J([]) }), 'test kind', /Only reminders/);
    fails(await rpc('alice', 'replace_scheduled_jobs', { p_kind: 'rest_over', p_jobs: J([job('rest:w', 1, { payload: { url: '//evil.example/x' } })]) }), 'external url', /in-app url/);
    fails(await rpc('alice', 'replace_scheduled_jobs', { p_kind: 'rest_over', p_jobs: J([job('rest:w', 1, { payload: { title: '' } })]) }), 'no title', /title/);
    fails(await rpc('alice', 'replace_scheduled_jobs', { p_kind: 'rest_over', p_jobs: J(Array.from({ length: 61 }, (_, i) => job(`k${i}`, 1))) }), 'too many', /at most 60/);
    eq(ok(await rpc('alice', 'replace_scheduled_jobs', { p_kind: 'rest_over', p_jobs: J([job('rest:old', -10), job('rest:far', 60 * 24 * 20)]) }), 'skip'), 0, 'past/far skipped');
    eq(ok(await rpc('alice', 'cancel_push_job', { p_dedupe_key: 'reminder:x' }), 'cancel bob’s'), false, 'cannot cancel another user’s job');
    eq(ok(await rpc('bob', 'cancel_push_job', { p_dedupe_key: 'reminder:x' }), 'cancel own'), true, 'own job cancelled');
    eq(await visible('bob', `select * from public.push_jobs where user_id = $1`, [U.alice]), 0, 'bob cannot read alice’s jobs');
  });

  await test('jobs', 'turning a kind off cancels its pending pushes; the test push needs a device', async () => {
    ok(await rpc('alice', 'replace_scheduled_jobs', { p_kind: 'rest_over', p_jobs: J([job('rest:w1', 2, { payload: { tag: 'rest', url: '/train/session/w1' } })]) }), 'rest');
    ok(await rpc('alice', 'set_push_prefs', { p: J({ kinds: ['workout_reminder', 'coaching', 'missed_nudge', 'social'] }) }), 'rest off');
    assert((await jobsOf(U.alice, `and dedupe_key = 'rest:w1'`))[0].cancelled_at, 'rest job cancelled');
    ok(await rpc('alice', 'send_test_push'), 'test push');
    eq((await jobsOf(U.alice, `and kind = 'test'`)).length, 1, 'queued');
    fails(await rpc('eve', 'send_test_push'), 'no device', /Turn on notifications/);
  });

  /* ------------------------------------------------------------ coaching/social from in-app notifications */
  await test('notifications', 'in-app social notification → push only when social is on and a device exists; bursts coalesce (≤ 1 per 2 min, latest text)', async () => {
    await admin.query(`delete from public.push_jobs`);
    // bob: social off by default → nothing
    await admin.query(`insert into public.notifications (recipient_id, actor_id, type) values ($1, $2, 'friend_request')`, [U.bob, U.alice]);
    eq((await jobsOf(U.bob)).length, 0, 'social off → no push');
    // alice: social on + device

    await admin.query(`insert into public.notifications (recipient_id, actor_id, type) values ($1, $2, 'friend_request')`, [U.alice, U.bob]);
    await admin.query(`insert into public.notifications (recipient_id, actor_id, type) values ($1, $2, 'friend_accept')`, [U.alice, U.eve]);
    let js = await jobsOf(U.alice, `and kind = 'social'`);
    eq(js.length, 1, 'coalesced into one unsent job');
    const pl = js[0].payload;
    eq([pl.title, pl.body, pl.url, pl.tag], ['Hard Earned', 'Eve accepted your friend request', '/friends', 'social'], 'latest text, no content');
    await admin.query(`update public.push_jobs set sent_at = now() where id = $1`, [js[0].id]);
    await admin.query(`insert into public.notifications (recipient_id, actor_id, type) values ($1, $2, 'friend_request')`, [U.alice, U.eve]);
    js = await jobsOf(U.alice, `and kind = 'social' and sent_at is null`);
    eq(js.length, 1, 'new job after the sent one');
    const gap = (new Date(js[0].fire_at) - Date.now()) / 1000;
    assert(gap > 100 && gap <= 121, `fires ≈ 2 min after the last sent one (got ${gap}s)`);

  });

  await test('notifications', 'coach message → "Your coach sent you a message" (never the text), deep link to the conversation; respects the coaching kind', async () => {
    await admin.query(`delete from public.push_jobs`);
    await admin.query(`insert into public.notifications (recipient_id, actor_id, type, coach_id) values ($1, $2, 'coach_message', $2)`, [U.alice, U.bob]);
    const js = await jobsOf(U.alice, `and kind = 'coaching'`);
    eq(js.length, 1, 'one coaching push');
    eq(js[0].payload.body, 'Your coach sent you a message', 'no message content');
    eq(js[0].payload.url, '/coaching', 'no relationship id → coaching hub (with one: /coaching/messages/<id>)');
    ok(await rpc('alice', 'set_push_prefs', { p: J({ kinds: ['workout_reminder'] }) }), 'coaching off');
    await admin.query(`delete from public.push_jobs`);
    await admin.query(`insert into public.notifications (recipient_id, actor_id, type) values ($1, $2, 'friend_request')`, [U.alice, U.eve]);
    eq((await jobsOf(U.alice)).length, 0, 'kinds off → nothing');
    ok(await rpc('alice', 'set_push_prefs', { p: J({ kinds: ['workout_reminder', 'rest_over', 'coaching', 'missed_nudge', 'social'] }) }), 'restore');
  });

  /* ------------------------------------------------------------ push-send side */
  await test('send', 'claim → finish: sent / deferred / retry (cancelled after 5 attempts) / dropped; 410 deletes the subscription; cleanup', async () => {
    await admin.query(`delete from public.push_jobs`);
    ok(await rpc('alice', 'replace_scheduled_jobs', { p_kind: 'rest_over', p_jobs: J([job('r1', 0), job('r2', 0), job('r3', 0), job('r4', 0)]) }), 'jobs');
    await admin.query(`update public.push_jobs set fire_at = now() - interval '1 second' where user_id = $1`, [U.alice]);
    const claimed = ok(await rpc('service', 'push_claim_due', { p_limit: 10 }), 'claim');
    eq(claimed.length, 4, 'four due');
    assert(claimed[0].subscriptions.length === 1 && claimed[0].prefs.timeZone === 'Europe/Oslo', 'subscriptions + prefs included');
    eq(ok(await rpc('service', 'push_claim_due', { p_limit: 10 }), 'claim again'), [], 'claimed jobs are not handed out twice');
    const byKey = Object.fromEntries((await jobsOf(U.alice)).map((j) => [j.dedupe_key, j.id]));
    const tok = Object.fromEntries(claimed.map((c) => [c.id, c.token]));
    assert(claimed.every((c) => /^[0-9a-f-]{36}$/.test(c.token)), 'each claim carries an attempt token');
    const later = new Date(Date.now() + 3600_000).toISOString();
    await admin.query(`update public.push_jobs set attempts = 5 where id = $1`, [byKey.r3]);
    // A wrong token settles nothing.
    ok(await rpc('service', 'push_finish', { p_results: J([{ id: byKey.r1, token: randomUUID(), status: 'sent' }]) }), 'wrong token');
    assert(!(await jobsOf(U.alice, `and dedupe_key = 'r1'`))[0].sent_at, 'wrong token ignored');
    ok(await rpc('service', 'push_finish', { p_results: J([{ id: byKey.r1, token: tok[byKey.r1], status: 'sent' }, { id: byKey.r2, token: tok[byKey.r2], status: 'deferred', fireAt: later }, { id: byKey.r3, token: tok[byKey.r3], status: 'retry' }, { id: byKey.r4, token: tok[byKey.r4], status: 'dropped' }]) }), 'finish');
    const rows = Object.fromEntries((await jobsOf(U.alice)).map((j) => [j.dedupe_key, j]));
    assert(rows.r1.sent_at && !rows.r1.cancelled_at, 'sent');
    assert(!rows.r2.sent_at && rows.r2.fire_at.toISOString() === later && !rows.r2.claimed_at, 'deferred');
    assert(rows.r3.cancelled_at, 'retried too often → cancelled');
    assert(rows.r4.cancelled_at, 'dropped');
    ok(await rpc('service', 'push_subscription_result', { p_endpoint: SUB(1).endpoint, p_status: 500 }), '500');
    eq((await admin.query(`select failed_count from public.push_subscriptions where endpoint = $1`, [SUB(1).endpoint])).rows[0].failed_count, 1, 'failed_count + 1');
    ok(await rpc('service', 'push_subscription_result', { p_endpoint: SUB(1).endpoint, p_status: 410 }), '410');
    eq((await admin.query(`select count(*)::int n from public.push_subscriptions where endpoint = $1`, [SUB(1).endpoint])).rows[0].n, 0, '410 deletes');
    await admin.query(`update public.push_jobs set sent_at = now() - interval '8 days' where id = $1`, [byKey.r1]);
    await admin.query(`update public.push_jobs set cancelled_at = now() - interval '8 days' where id = $1`, [byKey.r4]);
    eq(ok(await rpc('service', 'push_cleanup', {}), 'cleanup'), 2, 'old sent/cancelled removed');
  });

  await test('send', 'SKIP LOCKED: two connections claiming at the same time never get the same job', async () => {
    await admin.query(`delete from public.push_jobs`);
    await admin.query(`insert into public.push_jobs (user_id, kind, fire_at, payload, dedupe_key)
      select $1, 'workout_reminder', now() - interval '1 minute', '{"title":"t","body":"","url":"/","tag":"w"}'::jsonb, 'k' || g from generate_series(1, 40) g`, [U.alice]);
    const c1 = new pg.Client({ host: 'localhost', port: PORT, user: 'postgres', database: 'postgres' });
    const c2 = new pg.Client({ host: 'localhost', port: PORT, user: 'postgres', database: 'postgres' });
    await c1.connect();
    await c2.connect();
    const claim = async (c, n) => {
      await c.query('set role service_role');
      return (await c.query(`select public.push_claim_due($1) as v`, [n])).rows[0].v.map((j) => j.id);
    };
    try {
      // c1 holds its claim open in a transaction while c2 claims: locked rows are skipped, not waited on.
      await c1.query('begin');
      const a = await claim(c1, 10);
      const b = await claim(c2, 50);
      eq(a.length, 10, 'c1 got 10');
      eq(b.length, 30, 'c2 got the other 30 without waiting');
      eq(a.filter((id) => b.includes(id)), [], 'disjoint');
      await c1.query('commit');
      eq((await claim(c2, 50)).length, 0, 'after commit nothing is claimable again');
      // Many overlapping claims across both connections: still no duplicates.
      await admin.query(`update public.push_jobs set claimed_at = null, lease_until = null, claim_token = null, dispatch_state = 'pending'`);
      const all = (await Promise.all([claim(c1, 7), claim(c2, 7), claim(c1, 7), claim(c2, 7), claim(c1, 7), claim(c2, 7)])).flat();
      eq(new Set(all).size, all.length, 'no job claimed twice');
      eq(all.length, 40, 'every job claimed once');
    } finally {
      await c1.end();
      await c2.end();
    }
  });


  /* ------------------------------------------------------------ phase 1: coach reminders */
  const todayUtc = () => new Date().toISOString().slice(0, 10);
  const dayShift = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const accountState = (user, settings) =>
    admin.query(`insert into public.account_state (owner_id, id, version, payload) values ($1, $1, 1, $2)
                 on conflict (owner_id, id) do update set payload = excluded.payload`, [user, JSON.stringify({ settings })]);
  async function proactive(user, kind, key, { event = null, source = null, expires = '1 hour' } = {}) {
    const r = await admin.query(`insert into public.push_jobs (user_id, kind, fire_at, payload, dedupe_key, event_date, source_ref, expires_at)
      values ($1, $2, now() - interval '1 second', '{"title":"Hard Earned","body":"x","url":"/","tag":"workout"}', $3,
              coalesce($4::date, (now() at time zone 'UTC')::date), $5, now() + $6::interval) returning id`, [user, kind, key, event, source, expires]);
    return r.rows[0].id;
  }
  const claimAll = async () => ok(await rpc('service', 'push_claim_due', { p_limit: 50 }), 'claim');
  const check = async (id, token, stage) => ok(await rpc('service', 'push_check', { p_id: id, p_token: token, p_stage: stage }), `check ${stage}`);
  const tokenOf = (claimed, id) => claimed.find((c) => c.id === id)?.token;
  const prefsOf = async (actor) => ok(await rpc(actor, 'get_push_prefs'), 'get prefs');
  const update = async (actor, patch, rev) => ok(await rpc(actor, 'update_push_prefs', { p_patch: J(patch), p_revision: [rev, '::bigint'] }), 'update');

  await test('phase1', 'defaults: cap 2, no pause, revision; food reminders stay off; legacy writes keep the new fields', async () => {
    const d = await prefsOf('carol');
    eq([d.dailyCap, d.snoozeUntil, d.revision], [2, null, 0], 'defaults before any write');
    assert(!d.kinds.includes('food_unlogged'), 'food off by default');
    ok(await rpc('carol', 'save_push_subscription', { p: J(SUB(20)) }), 'carol device');
    const r1 = await update('carol', { kinds: [...d.kinds, 'food_unlogged'], dailyCap: 3 }, 1);
    eq(r1.status, 'ok', 'versioned update');
    eq([r1.prefs.dailyCap, r1.prefs.kinds.includes('food_unlogged'), r1.prefs.revision], [3, true, 2], 'stored + revision bumped');
    // An old app sends its kinds list without food_unlogged and no cap: both are preserved.
    const legacy = ok(await rpc('carol', 'set_push_prefs', { p: J({ kinds: ['workout_reminder', 'coaching'], dailyCap: 1, snoozeDays: 7 }) }), 'legacy');
    eq([legacy.kinds.includes('food_unlogged'), legacy.dailyCap, legacy.snoozeUntil, legacy.revision], [true, 3, null, 3], 'legacy preserved new fields');
    const stale = await update('carol', { dailyCap: 1 }, 2);
    eq([stale.status, stale.prefs.dailyCap, stale.prefs.revision], ['conflict', 3, 3], 'stale revision → conflict, nothing written');
    eq((await update('carol', { dailyCap: 4 }, 3)).status === 'invalid' && (await update('carol', { dailyCap: 4 }, 3)).field, 'cap', 'cap 1..3');
    eq((await update('carol', { snoozeDays: 2 }, 3)).field, 'snoozeDays', 'snooze 1/3/7/14 only');
    eq((await update('carol', { quietStart: '24:00' }, 3)).field, 'time', 'time validated');
    eq((await prefsOf('carol')).revision, 3, 'invalid patches write nothing');
    // Existing rows from before the migration keep their kinds (including an explicitly empty list).
    ok(await rpc('dave', 'set_push_prefs', { p: J({ kinds: [] }) }), 'dave empty kinds');
    eq((await prefsOf('dave')).kinds, [], 'explicitly empty kinds kept');
  });

  await test('phase1', 'snooze lasts until the same local time N days later (DST-aware, stored UTC); resume needs the server; other users unaffected', async () => {
    ok(await rpc('dave', 'set_push_prefs', { p: J({ timeZone: 'Europe/Oslo' }) }), 'dave tz');
    const rev = (await prefsOf('dave')).revision;
    const r = await update('dave', { snoozeDays: 7 }, rev);
    eq(r.status, 'ok', 'snoozed');
    const expect = (await admin.query(`select ((now() at time zone 'Europe/Oslo') + interval '7 days') at time zone 'Europe/Oslo' as t`)).rows[0].t;
    const got = (await admin.query(`select snooze_until from public.push_prefs where user_id = $1`, [U.dave])).rows[0].snooze_until;
    assert(Math.abs(got - expect) < 5000, `snooze_until ${got.toISOString()} vs ${expect.toISOString()}`);
    eq(typeof r.prefs.snoozeUntil, 'string', 'snoozeUntil returned');
    const res = await update('dave', { resume: true }, r.prefs.revision);
    eq([res.status, res.prefs.snoozeUntil], ['ok', null], 'resumed');
    eq((await prefsOf('carol')).snoozeUntil, null, 'carol not paused');
    fails(await rpc('anon', 'update_push_prefs', { p_patch: J({}), p_revision: [0, '::bigint'] }), 'anon update', /permission denied/);
    fails(await rpc('anon', 'record_sync_complete'), 'anon receipt', /permission denied/);
    fails(await rpc('carol', 'push_check', { p_id: randomUUID(), p_token: randomUUID(), p_stage: 'prepare' }), 'user check', /permission denied/);
    fails(await rpc('carol', 'push_generate_food'), 'user generate', /permission denied/);
  });

  await test('phase1', 'uploads store event/source dates and expiry; a claimed job’s lease is never reset and sent/discarded jobs are never revived', async () => {
    await admin.query(`delete from public.push_jobs`);
    const fire = new Date(Date.now() + 5 * 60_000);
    const day = (await admin.query(`select ($1::timestamptz at time zone 'Europe/Oslo')::date::text d`, [fire.toISOString()])).rows[0].d;
    ok(await rpc('dave', 'replace_scheduled_jobs', { p_kind: 'missed_nudge', p_jobs: J([job('nudge:x', 5, { eventDate: day, sourceDate: dayShift(day, -1) })]) }), 'upload');
    const [row] = await jobsOf(U.dave);
    eq([row.source_type, row.source_ref, row.event_date && row.event_date.toISOString().slice(0, 10) !== undefined], ['missed_session', dayShift(day, -1), true], 'typed source');
    assert(row.expires_at > fire, 'expires after fire');
    // Claim it, then re-upload with a new time: the lease and token stay.
    await admin.query(`update public.push_jobs set fire_at = now() - interval '1 second' where id = $1`, [row.id]);
    const claimed = await claimAll();
    const token = tokenOf(claimed, row.id);
    ok(await rpc('dave', 'replace_scheduled_jobs', { p_kind: 'missed_nudge', p_jobs: J([job('nudge:x', 7, { eventDate: day, sourceDate: dayShift(day, -1) })]) }), 'reupload');
    const after = (await jobsOf(U.dave))[0];
    eq([after.claim_token, after.dispatch_state], [token, 'claimed'], 'lease untouched');
    await admin.query(`update public.push_jobs set dispatch_state = 'discarded', cancelled_at = now(), claim_token = null, lease_until = null where id = $1`, [row.id]);
    ok(await rpc('dave', 'replace_scheduled_jobs', { p_kind: 'missed_nudge', p_jobs: J([job('nudge:x', 9, { eventDate: day, sourceDate: dayShift(day, -1) })]) }), 'reupload 2');
    const again = (await jobsOf(U.dave))[0];
    assert(again.cancelled_at && again.dispatch_state === 'discarded', 'discarded job not revived');
    // A job outside its own local day is refused.
    eq(ok(await rpc('dave', 'replace_scheduled_jobs', { p_kind: 'workout_reminder', p_jobs: J([job('reminder:bad', 5, { eventDate: dayShift(day, 3) })]) }), 'bad day'), 0, 'event day mismatch skipped');
  });

  await test('phase1', 'attempt ownership: only the current claim token can check or settle; an expired lease is re-claimed with a new token', async () => {
    await admin.query(`delete from public.push_jobs`);
    await accountState(U.carol, { language: 'is', nutritionEnabled: true, demoData: false });
    const id = await proactive(U.carol, 'workout_reminder', 'reminder:own');
    const t1 = tokenOf(await claimAll(), id);
    eq((await check(id, randomUUID(), 'prepare')).status, 'lost', 'foreign token');
    await admin.query(`update public.push_jobs set lease_until = now() - interval '1 second' where id = $1`, [id]);
    const t2 = tokenOf(await claimAll(), id);
    assert(t2 && t2 !== t1, 'new token');
    eq((await check(id, t1, 'prepare')).status, 'lost', 'old attempt lost ownership');
    const ok1 = await check(id, t2, 'prepare');
    eq([ok1.status, ok1.language], ['ok', 'is'], 'current owner, Icelandic account language');
    ok(await rpc('service', 'push_finish', { p_results: J([{ id, token: t1, status: 'sent' }]) }), 'old finish');
    assert(!(await jobsOf(U.carol))[0].sent_at, 'old attempt cannot settle');
    eq((await check(id, t2, 'dispatch')).status, 'ok', 'dispatch');
    ok(await rpc('service', 'push_finish', { p_results: J([{ id, token: t2, status: 'sent', copy: { body: 'Opnaðu Í dag þegar þér hentar.', language: 'is', source: 'fallback' } }]) }), 'finish');
    const done = (await jobsOf(U.carol))[0];
    eq([done.dispatch_state, done.copy_language, done.copy_source, done.payload.body], ['sent', 'is', 'fallback', 'Opnaðu Í dag þegar þér hentar.'], 'settled with cached copy');
    eq((await admin.query(`select state from private.push_quota where job_id = $1`, [id])).rows.map((r) => r.state), ['consumed'], 'reservation consumed');
  });

  await test('phase1', 'quota: one training reminder per day (workout preferred over missed), cap counts logical events across devices', async () => {
    await admin.query(`delete from public.push_jobs; delete from private.push_quota`);
    ok(await rpc('carol', 'save_push_subscription', { p: J(SUB(21)) }), 'second device');
    await admin.query(`update public.push_prefs set kinds = array['workout_reminder', 'missed_nudge', 'food_unlogged', 'rest_over'] where user_id = $1`, [U.carol]);
    const w = await proactive(U.carol, 'workout_reminder', 'reminder:q');
    const m = await proactive(U.carol, 'missed_nudge', 'nudge:q', { source: dayShift(todayUtc(), -1) });
    const c = await claimAll();
    eq((await check(m, tokenOf(c, m), 'prepare')).reason, 'workout_preferred', 'missed nudge yields to the workout reminder');
    eq((await check(w, tokenOf(c, w), 'prepare')).status, 'ok', 'workout reserved');
    // A second training reminder the same day (e.g. re-uploaded under another key) can't reserve.
    const w2 = await proactive(U.carol, 'workout_reminder', 'reminder:q2');
    const c2 = await claimAll();
    eq((await check(w2, tokenOf(c2, w2), 'prepare')).reason, 'training_done_today', 'one training reminder per day');
    // Cap 1: the food event can't reserve once training holds today's only slot.
    const rev = (await prefsOf('carol')).revision;
    eq((await update('carol', { dailyCap: 1 }, rev)).status, 'ok', 'cap 1');
    await admin.query(`insert into private.sync_receipts (user_id, completed_at) values ($1, now()) on conflict (user_id) do update set completed_at = now()`, [U.carol]);
    await admin.query(`update public.push_prefs set time_zone = 'UTC' where user_id = $1`, [U.carol]);
    const f = await proactive(U.carol, 'food_unlogged', 'food:q');
    const c3 = await claimAll();
    eq((await check(f, tokenOf(c3, f), 'prepare')).reason, 'daily_cap', 'cap reached');
    eq((await admin.query(`select count(*)::int n from private.push_quota where user_id = $1`, [U.carol])).rows[0].n, 1, 'one reservation for two devices');
  });

  await test('phase1', 'concurrent workers: two connections preparing different jobs for the same event reserve once', async () => {
    await admin.query(`delete from public.push_jobs; delete from private.push_quota`);
    const a = await proactive(U.carol, 'workout_reminder', 'reminder:c1');
    const b = await proactive(U.carol, 'workout_reminder', 'reminder:c2');
    const c = await claimAll();
    const c1 = new pg.Client({ host: 'localhost', port: PORT, user: 'postgres', database: 'postgres' });
    const c2 = new pg.Client({ host: 'localhost', port: PORT, user: 'postgres', database: 'postgres' });
    await c1.connect();
    await c2.connect();
    try {
      await c1.query('set role service_role');
      await c2.query('set role service_role');
      const run = (cl, id) => cl.query(`select public.push_check($1, $2, 'prepare') as v`, [id, tokenOf(c, id)]).then((r) => r.rows[0].v.status);
      const res = await Promise.all([run(c1, a), run(c2, b)]);
      eq(res.sort(), ['discard', 'ok'], 'exactly one reserved');
    } finally {
      await c1.end();
      await c2.end();
    }
  });

  await test('phase1', 'opt-out, pause and completed workouts during generation stop a stale dispatch; demo accounts get nothing', async () => {
    await admin.query(`delete from public.push_jobs; delete from private.push_quota`);
    await admin.query(`update public.push_prefs set daily_cap = 3 where user_id = $1`, [U.carol]);
    let id = await proactive(U.carol, 'workout_reminder', 'reminder:o1');
    let c = await claimAll();
    eq((await check(id, tokenOf(c, id), 'prepare')).status, 'ok', 'prepared');
    const p = await prefsOf('carol');
    eq((await update('carol', { kinds: p.kinds.filter((k) => k !== 'workout_reminder') }, p.revision)).status, 'ok', 'opt out mid-generation');
    eq((await check(id, tokenOf(c, id), 'dispatch')).status, 'discard', 'opted out → not dispatched');
    eq((await admin.query(`select count(*)::int n from private.push_quota where job_id = $1`, [id])).rows[0].n, 0, 'reservation released');
    const p2 = await prefsOf('carol');
    ok(await update('carol', { kinds: [...p2.kinds, 'workout_reminder'] }, p2.revision), 'opt in again');
    id = await proactive(U.carol, 'workout_reminder', 'reminder:o2');
    c = await claimAll();
    eq((await check(id, tokenOf(c, id), 'prepare')).status, 'ok', 'prepared 2');
    const p3 = await prefsOf('carol');
    ok(await update('carol', { snoozeDays: 1 }, p3.revision), 'pause mid-generation');
    eq((await check(id, tokenOf(c, id), 'dispatch')).reason, 'snoozed', 'paused → discarded, no catch-up');
    const p4 = await prefsOf('carol');
    ok(await update('carol', { resume: true }, p4.revision), 'resume');
    id = await proactive(U.carol, 'workout_reminder', 'reminder:o3');
    c = await claimAll();
    await admin.query(`insert into public.workout_sessions (owner_id, id, version, payload) values ($1, $2, 1, $3)`, [U.carol, randomUUID(), JSON.stringify({ status: 'completed', date: todayUtc() })]);
    eq((await check(id, tokenOf(c, id), 'prepare')).reason, 'source_done', 'already trained today');
    await accountState(U.carol, { language: 'en', nutritionEnabled: true, demoData: true });
    id = await proactive(U.carol, 'missed_nudge', 'nudge:o4', { source: dayShift(todayUtc(), -3) });
    c = await claimAll();
    eq((await check(id, tokenOf(c, id), 'prepare')).reason, 'demo', 'demo data → no reminders');
    await accountState(U.carol, { language: 'en', nutritionEnabled: true, demoData: false });
    id = await proactive(U.carol, 'missed_nudge', 'nudge:o5', { source: dayShift(todayUtc(), -3), expires: '-1 second' });
    c = await claimAll();
    eq((await check(id, tokenOf(c, id), 'prepare')).reason, 'expired', 'expired candidate');
  });

  await test('phase1', 'food reminders: server-generated at 19:00 local; need nutrition on, zero logs today and a fresh completed sync', async () => {
    await admin.query(`delete from public.push_jobs; delete from private.push_quota`);
    // A zone where it is currently before 18:00 local time.
    const zone = (await admin.query(`select z from unnest(array['UTC','Etc/GMT+6','Etc/GMT-6','Etc/GMT+11','Etc/GMT-12']) z
                                      where (now() at time zone z)::time < time '18:00' limit 1`)).rows[0].z;
    await admin.query(`update public.push_prefs set time_zone = $2 where user_id = $1`, [U.carol, zone]);
    const before = await jobsOf(U.carol);
    const n1 = ok(await rpc('service', 'push_generate_food'), 'generate');
    eq(n1 >= 1, true, 'generated');
    eq(ok(await rpc('service', 'push_generate_food'), 'generate again') >= 0, true, 'idempotent call');
    const foods = (await jobsOf(U.carol)).filter((j) => j.kind === 'food_unlogged');
    eq(foods.length - before.filter((j) => j.kind === 'food_unlogged').length, 1, 'one per day');
    const local = (await admin.query(`select to_char($1::timestamptz at time zone $2, 'HH24:MI') t`, [foods[0].fire_at, zone])).rows[0].t;
    eq([local, foods[0].payload.url, foods[0].source_type], ['19:00', '/nutrition/log', 'food_day'], '19:00 local, opens the food log');
    eq((await jobsOf(U.dave)).filter((j) => j.kind === 'food_unlogged').length, 0, 'not for users who did not opt in');
    // Eligibility at send time (UTC for a stable local day).
    await admin.query(`update public.push_prefs set time_zone = 'UTC' where user_id = $1`, [U.carol]);
    await admin.query(`delete from public.push_jobs`);
    await admin.query(`delete from private.sync_receipts where user_id = $1`, [U.carol]);
    const run = async (key) => {
      const id = await proactive(U.carol, 'food_unlogged', key);
      const c = await claimAll();
      return check(id, tokenOf(c, id), 'prepare');
    };
    eq((await run('food:1')).reason, 'sync_stale', 'no completed sync → skip');
    await admin.query(`insert into private.sync_receipts (user_id, completed_at) values ($1, now() - interval '25 hours')`, [U.carol]);
    eq((await run('food:2')).reason, 'sync_stale', 'stale sync → skip');
    ok(await rpc('carol', 'record_sync_complete'), 'sync receipt');
    await accountState(U.carol, { language: 'en', nutritionEnabled: false });
    eq((await run('food:3')).reason, 'nutrition_off', 'nutrition off');
    await accountState(U.carol, { language: 'en', nutritionEnabled: true });
    await admin.query(`insert into public.food_logs (owner_id, id, version, payload, deleted_at) values ($1, $2, 1, $3, now())`, [U.carol, randomUUID(), JSON.stringify({ date: todayUtc() })]);
    eq((await run('food:4')).status, 'ok', 'deleted logs don’t count');
    await admin.query(`delete from public.push_jobs; delete from private.push_quota`);
    await admin.query(`insert into public.food_logs (owner_id, id, version, payload) values ($1, $2, 1, $3)`, [U.carol, randomUUID(), JSON.stringify({ date: todayUtc() })]);
    eq((await run('food:5')).reason, 'source_done', 'food logged today');
  });

  await test('phase1', 'a dispatch whose worker died is settled as ambiguous: never re-sent, reservation consumed', async () => {
    await admin.query(`delete from public.push_jobs; delete from private.push_quota`);
    await admin.query(`delete from public.workout_sessions where owner_id = $1`, [U.carol]);
    const id = await proactive(U.carol, 'workout_reminder', 'reminder:amb');
    const c = await claimAll();
    eq((await check(id, tokenOf(c, id), 'prepare')).status, 'ok', 'prepare');
    eq((await check(id, tokenOf(c, id), 'dispatch')).status, 'ok', 'dispatch');
    await admin.query(`update public.push_jobs set lease_until = now() - interval '1 second' where id = $1`, [id]);
    eq((await claimAll()).filter((j) => j.id === id).length, 0, 'not handed out again');
    const row = (await jobsOf(U.carol))[0];
    assert(row.sent_at && row.dispatch_state === 'ambiguous', 'ambiguous');
    eq((await admin.query(`select state from private.push_quota where job_id = $1`, [id])).rows[0].state, 'consumed', 'consumed');
  });

  await test('retention', 'deleting the user removes their subscriptions, prefs and jobs', async () => {
    ok(await rpc('eve', 'save_push_subscription', { p: J(SUB(7)) }), 'eve sub');
    await admin.query(`delete from auth.users where id = $1`, [U.eve]);
    for (const t of ['push_subscriptions', 'push_prefs', 'push_jobs']) eq((await admin.query(`select count(*)::int n from public.${t} where user_id = $1`, [U.eve])).rows[0].n, 0, t);
    await admin.query(`delete from auth.users where id = $1`, [U.carol]);
    for (const t of ['private.push_quota', 'private.sync_receipts', 'public.push_prefs']) eq((await admin.query(`select count(*)::int n from ${t} where user_id = $1`, [U.carol])).rows[0].n, 0, t);
  });
}

let exitCode = 0;
try {
  await main();
} catch (e) {
  results.push({ area: 'harness', name: current || 'startup', ok: false, err: e.stack || e.message });
} finally {
  await app?.end().catch(() => {});
  await admin?.end().catch(() => {});
  stopCluster();
}
const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log('\nPush notification database tests\n');
const aw = Math.max(...results.map((r) => r.area.length));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.area.padEnd(aw)}  ${r.name}${r.ok ? '' : `\n        → ${r.err}`}`);
console.log(`\n${fail === 0 ? 'ALL PASSED' : 'FAILURES'}: ${pass} passed, ${fail} failed, ${results.length} total`);
if (fail) exitCode = 1;
process.exit(exitCode);
