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
const U = { alice: randomUUID(), bob: randomUUID(), eve: randomUUID() };

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
    ok(await rpc('alice', 'replace_scheduled_jobs', { p_kind: 'workout_reminder', p_jobs: J([job('r1', 0), job('r2', 0), job('r3', 0), job('r4', 0)]) }), 'jobs');
    await admin.query(`update public.push_jobs set fire_at = now() - interval '1 second' where user_id = $1`, [U.alice]);
    const claimed = ok(await rpc('service', 'push_claim_due', { p_limit: 10 }), 'claim');
    eq(claimed.length, 4, 'four due');
    assert(claimed[0].subscriptions.length === 1 && claimed[0].prefs.timeZone === 'Europe/Oslo', 'subscriptions + prefs included');
    eq(ok(await rpc('service', 'push_claim_due', { p_limit: 10 }), 'claim again'), [], 'claimed jobs are not handed out twice');
    const byKey = Object.fromEntries((await jobsOf(U.alice)).map((j) => [j.dedupe_key, j.id]));
    const later = new Date(Date.now() + 3600_000).toISOString();
    await admin.query(`update public.push_jobs set attempts = 5 where id = $1`, [byKey.r3]);
    ok(await rpc('service', 'push_finish', { p_results: J([{ id: byKey.r1, status: 'sent' }, { id: byKey.r2, status: 'deferred', fireAt: later }, { id: byKey.r3, status: 'retry' }, { id: byKey.r4, status: 'dropped' }]) }), 'finish');
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
      await admin.query(`update public.push_jobs set claimed_at = null`);
      const all = (await Promise.all([claim(c1, 7), claim(c2, 7), claim(c1, 7), claim(c2, 7), claim(c1, 7), claim(c2, 7)])).flat();
      eq(new Set(all).size, all.length, 'no job claimed twice');
      eq(all.length, 40, 'every job claimed once');
    } finally {
      await c1.end();
      await c2.end();
    }
  });

  await test('retention', 'deleting the user removes their subscriptions, prefs and jobs', async () => {
    ok(await rpc('eve', 'save_push_subscription', { p: J(SUB(7)) }), 'eve sub');
    await admin.query(`delete from auth.users where id = $1`, [U.eve]);
    for (const t of ['push_subscriptions', 'push_prefs', 'push_jobs']) eq((await admin.query(`select count(*)::int n from public.${t} where user_id = $1`, [U.eve])).rows[0].n, 0, t);
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
