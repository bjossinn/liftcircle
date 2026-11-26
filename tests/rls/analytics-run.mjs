#!/usr/bin/env node
/**
 * Product analytics database tests: `node tests/rls/analytics-run.mjs` (npm run test:analytics-db)
 *
 * Same approach as tests/rls/push-run.mjs: a throwaway PostgreSQL 16 cluster, tests/rls/supabase-stub.sql, then EVERY
 * migration applied in order as the non-superuser `postgres` role, requests simulated with set local role + JWT claims.
 * Covers supabase/migrations/20261127000001_product_analytics.sql: RLS on, no client grants (nobody reads events back,
 * not even their own), log_product_events takes the user from the token, enforces the event/property allowlist
 * (free text, numbers, unknown keys and health-like fields are dropped), one-time milestones are idempotent per user,
 * batches are bounded, anon gets nothing, and deleting the account deletes the events.
 *
 * Env: PG_BIN (default /usr/lib/postgresql/16/bin), ANALYTICS_PG_PORT (default 54341), RLS_KEEP=1 keeps the cluster dir.
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
const PORT = Number(process.env.ANALYTICS_PG_PORT || 54341);
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-analytics-'));
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



const ev = (name, props = {}, over = {}) => ({ id: randomUUID(), name, props, occurred_at: new Date().toISOString(), ...over });
const rowsOf = async (user) => (await admin.query(`select event_name, props, user_id from public.product_analytics_events where user_id = $1 order by received_at, event_name`, [user])).rows;

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
  await test('setup', `apply ${migrations.length} migrations as non-superuser postgres`, async () => {
    assert(migrations.includes('20261127000001_product_analytics.sql'), 'analytics migration present');
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
  });
  if (!results.at(-1).ok) return;

  await test('setup', 'the migration is safe to re-run', async () => {
    await app.query('begin');
    await app.query(fs.readFileSync(path.join(migDir, '20261127000001_product_analytics.sql'), 'utf8'));
    await app.query('commit');
  });

  for (const [name, id] of Object.entries(U)) {
    await admin.query(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())`, [id, `${name}@example.test`]);
  }

  await test('setup', 'RLS on, no anon/authenticated table grants, definer function pinned and not anon-executable', async () => {
    const r1 = await admin.query(`select relrowsecurity from pg_class where relname = 'product_analytics_events' and relnamespace = 'public'::regnamespace`);
    eq(r1.rows.map((x) => x.relrowsecurity), [true], 'RLS enabled');
    const r2 = await admin.query(`select grantee, privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'product_analytics_events' and grantee in ('anon','authenticated','PUBLIC')`);
    eq(r2.rows, [], 'client grants');
    const r3 = await admin.query(`select p.proname, p.proconfig, has_function_privilege('anon', p.oid, 'execute') anon_exec,
        has_function_privilege('authenticated', p.oid, 'execute') auth_exec
      from pg_proc p where p.proname in ('log_product_events', 'analytics_props_ok') order by 1`);
    eq(r3.rows.map((x) => [x.proname, x.anon_exec, x.auth_exec]), [['analytics_props_ok', false, false], ['log_product_events', false, true]], 'execute grants');
    assert((r3.rows.find((x) => x.proname === 'log_product_events').proconfig ?? []).some((c) => c === 'search_path=""' || c === 'search_path='), 'search_path pinned');
  });

  await test('setup', 'the table has no column that could hold health data, chat content or PII', async () => {
    const r = await admin.query(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'product_analytics_events' order by ordinal_position`);
    eq(r.rows.map((x) => x.column_name), ['id', 'user_id', 'event_name', 'props', 'occurred_at', 'received_at'], 'columns');
  });

  await test('privileges', 'anon: no RPC, no rows; users cannot read or write the table directly', async () => {
    fails(await rpc('anon', 'log_product_events', { p_events: J([ev('first_set_logged')]) }), 'anon rpc', /permission denied/);
    assert((await visible('anon', `select * from public.product_analytics_events`)) <= 0, 'anon reads');
    fails(await as('alice', `insert into public.product_analytics_events (id, user_id, event_name, occurred_at) values (gen_random_uuid(), $1, 'workout_started', now())`, [U.alice]), 'direct insert', /permission denied/);
    eq(await visible('alice', `select * from public.product_analytics_events`), -1, 'alice cannot select (no grant)');
  });

  await test('log', 'stores allowlisted events for the caller (user from the token, never from the body)', async () => {
    const n = ok(await rpc('alice', 'log_product_events', { p_events: J([
      ev('first_set_logged'),
      ev('workout_started', { source: 'template' }),
      ev('ai_action_used', { action_type: 'chat_message', outcome: 'sent' }),
      { ...ev('first_workout_completed'), user_id: U.bob },
    ]) }), 'log');
    eq(n, 3, 'stored (the item carrying a user_id is dropped)');
    const rows = await rowsOf(U.alice);
    eq(rows.map((r) => r.event_name).sort(), ['ai_action_used', 'first_set_logged', 'workout_started'], 'alice rows');
    eq((await rowsOf(U.bob)).length, 0, 'nothing for bob');
  });

  await test('log', 'one-time milestones and retried ids are idempotent', async () => {
    const same = ev('workout_started', { source: 'empty' });
    eq(ok(await rpc('alice', 'log_product_events', { p_events: J([same, same, ev('first_set_logged')]) }), 'again'), 1, 'only the first copy of the new id');
    eq(ok(await rpc('alice', 'log_product_events', { p_events: J([same]) }), 'retry'), 0, 'retry of a sent batch');
    eq((await rowsOf(U.alice)).filter((r) => r.event_name === 'first_set_logged').length, 1, 'one first_set_logged');
    // Another user's id collision never touches alice's row.
    eq(ok(await rpc('bob', 'log_product_events', { p_events: J([same]) }), 'bob same id'), 0, 'skipped');
    eq(ok(await rpc('bob', 'log_product_events', { p_events: J([ev('first_set_logged')]) }), 'bob first'), 1, 'per user');
  });

  await test('privacy', 'health data, chat text, PII, unknown keys and non-enum values are rejected', async () => {
    const before = (await rowsOf(U.eve)).length;
    const bad = [
      ev('first_set_logged', { weightKg: '100' }),
      ev('first_workout_completed', { exercise: 'Bench press' }),
      ev('workout_started', { source: 'template', reps: '5' }),
      ev('workout_started', { source: 'I did 5x5 at 100kg' }),
      ev('workout_started', { source: 5 }),
      ev('ai_action_used', { action_type: 'chat_message', outcome: 'sent', message: 'my knee hurts' }),
      ev('ai_action_used', { action_type: 'chat_message' }),
      ev('ai_action_used', { action_type: { text: 'x' }, outcome: 'sent' }),
      ev('onboarding_completed', { path: 'suggested', email: 'eve@example.test' }),
      ev('chat_message_sent', {}),
      ev('body_weight_logged', { kg: '80' }),
      { ...ev('first_set_logged'), note: 'shoulder pain' },
      { ...ev('first_set_logged'), id: 'not-a-uuid' },
      ev('first_set_logged', {}, { occurred_at: 'yesterday-ish' }),
      ev('first_set_logged', {}, { occurred_at: '2020-01-01T00:00:00Z' }),
      'first_set_logged',
      null,
    ];
    eq(ok(await rpc('eve', 'log_product_events', { p_events: J(bad) }), 'bad batch'), 0, 'nothing stored');
    eq((await rowsOf(U.eve)).length, before, 'no rows');
    const stored = (await admin.query(`select props::text t from public.product_analytics_events`)).rows.map((r) => r.t).join(' ');
    assert(!/kg|reps|bench|knee|pain|email|@|shoulder|5x5/i.test(stored), `sensitive text stored: ${stored}`);
  });

  await test('privacy', 'the table itself refuses unknown event names (even for the owner role)', async () => {
    let threw = false;
    try {
      await admin.query(`insert into public.product_analytics_events (id, user_id, event_name, occurred_at) values (gen_random_uuid(), $1, 'note_added', now())`, [U.eve]);
    } catch {
      threw = true;
    }
    assert(threw, 'unknown name accepted');
  });

  await test('limits', 'more than 50 events per call and non-array input are refused; not signed in is refused', async () => {
    fails(await rpc('eve', 'log_product_events', { p_events: J(Array.from({ length: 51 }, () => ev('workout_started', { source: 'empty' }))) }), '51', /too many/);
    fails(await rpc('eve', 'log_product_events', { p_events: J({ name: 'first_set_logged' }) }), 'object', /array/);
    fails(await as('service', `select public.log_product_events('[]'::jsonb)`), 'no uid', /Not signed in|permission denied/);
  });

  await test('limits', 'daily abuse cap: after 500 rows a day further events are dropped quietly', async () => {
    await admin.query(`insert into public.product_analytics_events (id, user_id, event_name, props, occurred_at)
      select gen_random_uuid(), $1, 'workout_started', '{"source":"empty"}', now() from generate_series(1, 500)`, [U.eve]);
    eq(ok(await rpc('eve', 'log_product_events', { p_events: J([ev('workout_started', { source: 'empty' })]) }), 'over cap'), 0, 'dropped');
  });

  await test('retention', 'deleting the user removes their events', async () => {
    await admin.query(`delete from auth.users where id = $1`, [U.eve]);
    eq((await admin.query(`select count(*)::int n from public.product_analytics_events where user_id = $1`, [U.eve])).rows[0].n, 0, 'eve events');
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
console.log('\nProduct analytics database tests\n');
const aw = Math.max(...results.map((r) => r.area.length));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.area.padEnd(aw)}  ${r.name}${r.ok ? '' : `\n        → ${r.err}`}`);
console.log(`\n${fail === 0 ? 'ALL PASSED' : 'FAILURES'}: ${pass} passed, ${fail} failed, ${results.length} total`);
if (fail) exitCode = 1;
process.exit(exitCode);
