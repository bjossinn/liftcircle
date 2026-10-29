#!/usr/bin/env node
/**
 * LiftCircle database authorization tests (`npm run test:rls`).
 *
 * Starts a throwaway PostgreSQL 16 cluster, installs a minimal Supabase stand-in
 * (tests/rls/supabase-stub.sql: roles, auth.uid(), storage schema), applies EVERY migration in
 * supabase/migrations as the non-superuser `postgres` role, then exercises the access-control
 * matrix with real `set local role authenticated|anon|service_role` + request.jwt.claims,
 * exactly as PostgREST / Storage do for API requests.
 *
 * Env: PG_BIN (default /usr/lib/postgresql/16/bin), RLS_PG_PORT (default 54329), RLS_KEEP=1 keeps the cluster dir.
 */
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { coachingTests } from './coaching.mjs';
import { auditTests } from './audit.mjs';
import { publicCoachPreviewTests } from './publicCoachPreview.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = process.env.PG_BIN || '/usr/lib/postgresql/16/bin';
const PORT = Number(process.env.RLS_PG_PORT || 54329);
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

/* ------------------------------------------------------------ cluster lifecycle */
let tmp;
function sh(cmd, args, { allowFail = false } = {}) {
  const full = isRoot ? ['runuser', ['-u', 'postgres', '--', cmd, ...args]] : [cmd, args];
  const r = spawnSync(full[0], full[1], { encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`${cmd} failed (${r.status}): ${r.stderr || r.stdout || r.error}`);
  }
  return r;
}
function startCluster() {
  if (!fs.existsSync(path.join(BIN, 'initdb'))) throw new Error(`PostgreSQL binaries not found in ${BIN} (set PG_BIN).`);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-rls-'));
  if (isRoot) {
    // initdb refuses to run as root: run the cluster as the unprivileged `postgres` OS user.
    const r = spawnSync('id', ['-u', 'postgres']);
    if (r.status !== 0) throw new Error('Running as root but no `postgres` OS user exists to own the test cluster.');
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

/* ------------------------------------------------------------ test helpers */
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

let admin; // supabase_admin (superuser) — plays the Auth server / dashboard
let app; // postgres — the API gateway that switches roles per request

const U = {
  alice: randomUUID(), // owner
  bob: randomUUID(), // friend
  carol: randomUUID(), // stranger
  dave: randomUUID(), // friend who gets blocked
  mia: randomUUID(), // moderator
  eve: randomUUID(), // account that gets deleted
};

/** Run one statement as an API actor inside its own transaction (like one PostgREST request). */
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
      const sub = U[actor] ?? actor;
      await app.query('set local role authenticated');
      await app.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub, role: 'authenticated', aud: 'authenticated' })]);
    }
    const r = await app.query(sql, params);
    await app.query('commit');
    return { rows: r.rows, rowCount: r.rowCount };
  } catch (error) {
    await app.query('rollback');
    return { error, rows: [], rowCount: 0 };
  }
}
/** Call an RPC with named arguments as an actor. Returns { value } or { error }. */
const JSONB_ARGS = new Set(['p_payload', 'p_snapshot', 'p_media', 'p', 'p_intake', 'p_scopes', 'p_answers']);
async function rpc(actor, fn, args = {}) {
  const keys = Object.keys(args);
  const params = keys.map((k) => (JSONB_ARGS.has(k) && args[k] !== null ? JSON.stringify(args[k]) : args[k]));
  const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}${JSONB_ARGS.has(k) ? '::jsonb' : ''}`).join(', ')}) as v`;
  const r = await as(actor, sql, params);
  return r.error ? { error: r.error } : { value: r.rows[0]?.v };
}
function ok(r, what) {
  if (r.error) throw new Error(`${what}: unexpected error: ${r.error.message}`);
  return 'value' in r ? r.value : r.rows;
}
function fails(r, what, pattern) {
  if (!r.error) throw new Error(`${what}: expected an error but it succeeded`);
  if (pattern && !pattern.test(r.error.message)) throw new Error(`${what}: wrong error "${r.error.message}"`);
}
/** Read is denied = permission error OR zero visible rows. */
function denied(r, what) {
  if (r.error) return 'error';
  if (r.rows.length !== 0) throw new Error(`${what}: expected no visible rows, got ${r.rows.length}`);
  return 'empty';
}
async function count(actor, sql, params) {
  const r = await as(actor, sql, params);
  if (r.error) return -1; // permission error
  return Number(r.rows[0]?.n ?? r.rows.length);
}
async function adminCount(sql, params) {
  return Number((await admin.query(sql, params)).rows[0].n);
}

/* ------------------------------------------------------------ fixtures */
const ts = Date.now();
const S1 = randomUUID();
const sessionPayload = (v) => ({
  id: S1, name: 'Upper A', status: 'completed', date: '2026-10-27', timeZone: 'Atlantic/Reykjavik',
  startedAt: ts - 3600e3, endedAt: ts, pausedTotalMs: 0, createdAt: ts, updatedAt: ts + v,
  exercises: [
    { id: 'se1', exerciseId: 'barbell-bench-press', order: 0, sets: [
      { id: 's1', type: 'warmup', weightKg: 40, reps: 10, completed: true, completedAt: ts },
      { id: 's2', type: 'normal', weightKg: 80, reps: 8, rir: 2, completed: true, completedAt: ts },
      { id: 's3', type: 'normal', weightKg: 80, reps: v, completed: v > 0 } ] },
    { id: 'se2', exerciseId: 'pull-up', order: 1, discomfort: true, sets: [{ id: 's1', type: 'normal', reps: 6, completed: true }] },
  ],
});
const M_ID = randomUUID();
const F_ID = randomUUID();
const accountPayload = {
  id: 'account', createdAt: ts, updatedAt: ts,
  settings: { units: { weight: 'kg', length: 'cm', distance: 'km' }, notifications: { friendRequests: true, likes: true, comments: true } },
  profile: { displayName: 'Alice', age: 34, heightCm: 168, injuryNotes: 'Left shoulder impingement', limitations: ['shoulder'],
    diet: { tags: ['vegetarian'], allergens: ['peanuts'], dislikedIngredientIds: [], maxCookMinutes: 30, budget: 'any', mealsPerDay: 3 },
    onboardedAt: ts },
  nutrition: { mode: 'protein_only', proteinPerKg: 1.8, proteinG: 117, mealsPerDay: 3, updatedAt: ts },
  favorites: { exercises: [], recipes: [] },
};
const P1 = randomUUID(); // friends post with a photo
const P2 = randomUUID(); // only_me post with a photo
const M1 = randomUUID();
const M2 = randomUUID();
const C1 = randomUUID(); // bob's comment on P1
const C2 = randomUUID(); // dave's comment on P1
const C3 = randomUUID(); // alice's comment on P2
const C4 = randomUUID(); // bob's 2nd comment on P1 (removed by post author)
const objPath = (owner, post, media, thumb = false) => `${U[owner]}/${post}/${media}${thumb ? '_thumb' : ''}.jpg`;
const insertObject = (actor, bucket, name) =>
  as(actor, `insert into storage.objects (bucket_id, name, owner_id, metadata) values ($1, $2, $3, '{"size":1000,"mimetype":"image/jpeg"}') returning id`,
    [bucket, name, U[actor] ?? null]);
const selectObject = (actor, bucket, name) => as(actor, `select id from storage.objects where bucket_id = $1 and name = $2`, [bucket, name]);
const snapshot = { title: 'Upper body workout', kind: 'workout', date: '2026-10-27', durationSec: 3600, exercises: [{ name: 'Bench press' }] };

async function applyMigration(dir, f) {
  try {
    await app.query('begin');
    await app.query(fs.readFileSync(path.join(dir, f), 'utf8'));
    await app.query('commit');
  } catch (e) {
    await app.query('rollback');
    throw new Error(`${f}: ${e.message}${e.position ? ` (at char ${e.position})` : ''}`);
  }
}

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
  // Each migration is its own transaction (like `supabase db push`). A broken migration is reported as a
  // FAIL but the rest are still applied, so independent slices keep being verified.
  const core = migrations.filter((f) => f < '20261029');
  await test('setup', `apply ${core.length} base migrations as non-superuser postgres`, async () => {
    for (const f of core) await applyMigration(migDir, f);
  });
  if (!results.at(-1).ok) return;
  for (const f of migrations.filter((x) => x >= '20261029')) {
    await test('setup', `apply ${f}`, () => applyMigration(migDir, f));
  }
  const coachingReady = results.filter((r) => /coaching_(schema|rpcs|lockdown)/.test(r.name)).every((r) => r.ok);
  const seedPath = path.join(ROOT, 'supabase/seed.sql');
  if (fs.existsSync(seedPath)) {
    await test('setup', 'apply supabase/seed.sql (reference data)', async () => {
      await app.query(fs.readFileSync(seedPath, 'utf8'));
    });
  }

  await test('setup', 'RLS is enabled on every public table', async () => {
    const r = await admin.query(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
    eq(r.rows.map((x) => x.relname), [], 'tables without RLS');
  });
  await test('setup', 'anon/authenticated hold no INSERT/UPDATE/DELETE/TRUNCATE grant on any public table', async () => {
    const r = await admin.query(`select table_name, grantee, privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and grantee in ('anon','authenticated','PUBLIC') and privilege_type <> 'SELECT'`);
    eq(r.rows, [], 'write grants');
  });
  await test('setup', 'anon can SELECT only reference tables', async () => {
    const r = await admin.query(`select table_name from information_schema.role_table_grants
      where table_schema = 'public' and grantee = 'anon' order by 1`);
    eq(r.rows.map((x) => x.table_name), ['ref_exercises', 'ref_ingredients', 'ref_recipes'], 'anon grants');
  });
  await test('setup', 'every public security-definer function pins search_path and is not executable by anon', async () => {
    const r = await admin.query(`select p.proname, p.proconfig, has_function_privilege('anon', p.oid, 'execute') as anon_exec
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','private') and p.prosecdef`);
    // Deliberate exception: the signed-out coach preview (…30000004_public_coach_preview.sql, own tests in publicCoachPreview.mjs).
    const ANON_OK = new Set(['public_search_coaches', 'public_get_coach']);
    const bad = r.rows.filter((x) => !(x.proconfig ?? []).some((c) => c === 'search_path=""' || c === 'search_path=') || (x.anon_exec && !ANON_OK.has(x.proname)));
    eq(bad.map((x) => x.proname), [], 'functions missing search_path or executable by anon');
  });
  await test('setup', 'private schema helpers are not executable by anon', async () => {
    const r = await admin.query(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and has_function_privilege('anon', p.oid, 'execute') and p.proname not like 'try\\_%' and p.proname <> 'clip'`);
    eq(r.rows.map((x) => x.proname), [], 'anon-executable private helpers');
  });
  await test('setup', 'storage buckets are private with size + mime limits', async () => {
    const r = await admin.query(`select id, public, file_size_limit, allowed_mime_types from storage.buckets order by id`);
    eq(r.rows.map((b) => [b.id, b.public, Number(b.file_size_limit) > 0, b.allowed_mime_types]), [
      ['avatars', false, true, ['image/jpeg', 'image/webp']],
      ['coach-docs', false, true, ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']],
      ['coach-media', false, true, ['image/jpeg', 'image/webp']],
      ['coach-public', false, true, ['image/jpeg', 'image/webp']],
      ['post-media', false, true, ['image/jpeg', 'image/webp']]], 'buckets');
    eq(r.rows.filter((b) => b.id.startsWith('coach-')).map((b) => Number(b.file_size_limit)), [10485760, 5242880, 2097152], 'coach bucket size limits');
  });

  // ---- users (as created by GoTrue) + profiles
  for (const [name, id] of Object.entries(U)) {
    await admin.query(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())`, [id, `${name}@example.test`]);
  }
  await admin.query(`insert into public.app_roles (user_id, role) values ($1, 'moderator')`, [U.mia]);

  await test('profiles', 'each account creates a profile via save_my_profile', async () => {
    for (const name of Object.keys(U)) {
      ok(await rpc(name, 'save_my_profile', { p_username: name, p_display_name: name[0].toUpperCase() + name.slice(1), p_bio: `hi ${name}`, p_interests: ['lifting'] }), name);
    }
  });
  await test('profiles', 'duplicate username (case-insensitive) is rejected', async () => {
    fails(await rpc('carol', 'save_my_profile', { p_username: 'ALICE', p_display_name: 'x' }), 'dup', /taken/);
  });
  await test('profiles', 'username format enforced (no uppercase smuggling via citext)', async () => {
    fails(await rpc('carol', 'save_my_profile', { p_username: 'a!', p_display_name: 'x' }), 'bad format', /Usernames/);
    const r = await admin.query(`select count(*)::int n from public.profiles where username::text <> lower(username::text)`);
    eq(r.rows[0].n, 0, 'non-lowercase usernames');
  });
  await test('profiles', 'profiles table holds no email/health/role columns', async () => {
    const r = await admin.query(`select column_name from information_schema.columns where table_schema='public' and table_name='profiles' order by ordinal_position`);
    eq(r.rows.map((x) => x.column_name), ['id', 'username', 'display_name', 'avatar_path', 'bio', 'interests', 'discoverable', 'created_at', 'updated_at'], 'profile columns');
  });
  await test('profiles', 'username lookup returns only minimal public fields (no email/health)', async () => {
    const v = ok(await rpc('carol', 'get_profile_by_username', { p_username: 'Alice' }), 'lookup');
    eq(Object.keys(v.profile).sort(), ['avatar_path', 'bio', 'discoverable', 'display_name', 'id', 'interests', 'username'], 'fields');
    eq(v.relation, 'none', 'relation');
  });
  await test('profiles', 'stranger cannot enumerate profiles by direct SELECT', async () => {
    eq(await count('carol', `select * from public.profiles where id <> $1`, [U.carol]), 0, 'visible foreign profiles');
  });
  await test('profiles', 'signed-out cannot read profiles or call lookups', async () => {
    denied(await as('anon', `select * from public.profiles`), 'anon select');
    fails(await rpc('anon', 'get_profile_by_username', { p_username: 'alice' }), 'anon rpc');
  });

  // ---- friendships
  let reqAB;
  await test('friends', 'self friend request is rejected', async () => {
    fails(await rpc('alice', 'send_friend_request', { p_target: U.alice }), 'self', /yourself/);
  });
  await test('friends', 'alice → bob request; repeating it does not duplicate', async () => {
    reqAB = ok(await rpc('alice', 'send_friend_request', { p_target: U.bob }), 'send').id;
    const again = ok(await rpc('alice', 'send_friend_request', { p_target: U.bob }), 'send again');
    eq(again.id, reqAB, 'same request');
    eq(await adminCount(`select count(*) n from public.friendships where least(requester_id,addressee_id)=least($1::uuid,$2::uuid) and greatest(requester_id,addressee_id)=greatest($1::uuid,$2::uuid)`, [U.alice, U.bob]), 1, 'rows');
  });
  await test('friends', 'reverse duplicate row blocked by unordered-pair unique index', async () => {
    const r = await admin.query(`insert into public.friendships (requester_id, addressee_id) values ($1, $2)`, [U.bob, U.alice]).catch((e) => ({ error: e }));
    assert(r.error && /friendships_unique_pair/.test(r.error.message), 'expected unique violation');
  });
  await test('friends', 'requester cannot accept their own outgoing request', async () => {
    fails(await rpc('alice', 'respond_friend_request', { p_request_id: reqAB, p_accept: true }), 'self-accept', /not found/);
    eq((await admin.query(`select status from public.friendships where id=$1`, [reqAB])).rows[0].status, 'pending', 'status');
  });
  await test('friends', 'a third party cannot accept someone else’s request', async () => {
    fails(await rpc('carol', 'respond_friend_request', { p_request_id: reqAB, p_accept: true }), 'carol accept');
  });
  await test('friends', 'direct INSERT/UPDATE on friendships is denied', async () => {
    fails(await as('carol', `insert into public.friendships (requester_id, addressee_id, status) values ($1, $2, 'accepted')`, [U.carol, U.alice]), 'insert');
    fails(await as('alice', `update public.friendships set status='accepted' where id=$1`, [reqAB]), 'update');
  });
  await test('friends', 'addressee (bob) accepts; both get the right notifications', async () => {
    ok(await rpc('bob', 'respond_friend_request', { p_request_id: reqAB, p_accept: true }), 'accept');
    const bobN = ok(await rpc('bob', 'list_notifications'), 'bob n');
    const aliceN = ok(await rpc('alice', 'list_notifications'), 'alice n');
    assert(bobN.some((n) => n.type === 'friend_request' && n.actor.id === U.alice), 'bob has friend_request');
    assert(aliceN.some((n) => n.type === 'friend_accept' && n.actor.id === U.bob), 'alice has friend_accept');
  });
  await test('friends', 'after acceptance a new request in either direction is a no-op', async () => {
    eq(ok(await rpc('bob', 'send_friend_request', { p_target: U.alice }), 'bob→alice').status, 'accepted', 'status');
    eq(await adminCount(`select count(*) n from public.friendships where status='accepted' and $1 in (requester_id, addressee_id) and $2 in (requester_id, addressee_id)`, [U.alice, U.bob]), 1, 'rows');
  });
  await test('friends', 'dave ↔ alice become friends (request by dave)', async () => {
    const id = ok(await rpc('dave', 'send_friend_request', { p_target: U.alice }), 'send').id;
    ok(await rpc('alice', 'respond_friend_request', { p_request_id: id, p_accept: true }), 'accept');
  });
  await test('friends', 'carol → alice then cancels; alice → mia then declined', async () => {
    const id = ok(await rpc('carol', 'send_friend_request', { p_target: U.alice }), 'send').id;
    ok(await rpc('alice', 'cancel_friend_request', { p_request_id: id }), 'alice cannot cancel carol’s (no-op)');
    eq(await adminCount(`select count(*) n from public.friendships where id=$1`, [id]), 1, 'still there');
    ok(await rpc('carol', 'cancel_friend_request', { p_request_id: id }), 'cancel');
    eq(await adminCount(`select count(*) n from public.friendships where id=$1`, [id]), 0, 'cancelled');
    eq(await adminCount(`select count(*) n from public.notifications where friendship_id=$1`, [id]), 0, 'notification removed with request');
    const id2 = ok(await rpc('alice', 'send_friend_request', { p_target: U.mia }), 'send').id;
    ok(await rpc('mia', 'respond_friend_request', { p_request_id: id2, p_accept: false }), 'decline');
    eq(await adminCount(`select count(*) n from public.friendships where id=$1`, [id2]), 0, 'declined');
  });
  await test('friends', 'list_friends / list_friend_requests reflect state', async () => {
    const f = ok(await rpc('alice', 'list_friends'), 'friends');
    eq(f.map((p) => p.username).sort(), ['bob', 'dave'], 'alice friends');
    const r = ok(await rpc('alice', 'list_friend_requests'), 'requests');
    eq([r.incoming.length, r.outgoing.length], [0, 0], 'pending');
  });

  // ---- private records & sync (AT 13, 15)
  let v1, v2;
  await test('sync', 'push a workout session (base null) → ok with server version', async () => {
    const r = ok(await rpc('alice', 'sync_push', { p_entity: 'sessions', p_id: S1, p_op: 'upsert', p_base_version: null, p_payload: sessionPayload(5) }), 'push');
    eq(r.status, 'ok', 'status');
    v1 = Number(r.version);
    assert(v1 > 0, 'version');
  });
  await test('sync', 'session is normalized into session_exercises / session_sets', async () => {
    eq(await count('alice', `select count(*) n from public.session_exercises where session_id=$1`, [S1]), 2, 'exercises');
    eq(await count('alice', `select count(*) n from public.session_sets where session_id=$1`, [S1]), 4, 'sets');
    const r = await as('alice', `select set_type, weight_kg::float, reps, completed from public.session_sets where session_id=$1 and session_exercise_id='se1' order by position`, [S1]);
    eq(r.rows.map((x) => [x.set_type, x.weight_kg, x.reps, x.completed]), [['warmup', 40, 10, true], ['normal', 80, 8, true], ['normal', 80, 5, true]], 'sets');
    const s = await as('alice', `select session_date::text d, status, started_at is not null st from public.workout_sessions where id=$1`, [S1]);
    eq(s.rows[0], { d: '2026-10-27', status: 'completed', st: true }, 'typed projection');
  });
  await test('sync', 'retrying the same push (same id/base) does not duplicate; returns identical server copy', async () => {
    const r = ok(await rpc('alice', 'sync_push', { p_entity: 'sessions', p_id: S1, p_op: 'upsert', p_base_version: null, p_payload: sessionPayload(5) }), 'retry');
    eq(r.status, 'conflict', 'status');
    eq(r.payload, JSON.parse(JSON.stringify(r.payload)), 'payload');
    eq(r.payload.updatedAt, sessionPayload(5).updatedAt, 'identical payload');
    eq(await adminCount(`select count(*) n from public.workout_sessions where owner_id=$1`, [U.alice]), 1, 'rows');
    eq(await adminCount(`select count(*) n from public.session_sets where owner_id=$1`, [U.alice]), 4, 'set rows');
  });
  await test('sync', 'update with current base version → ok, new global version', async () => {
    const r = ok(await rpc('alice', 'sync_push', { p_entity: 'sessions', p_id: S1, p_op: 'upsert', p_base_version: v1, p_payload: sessionPayload(7) }), 'push');
    eq(r.status, 'ok', 'status');
    v2 = Number(r.version);
    assert(v2 > v1, 'monotonic version');
    eq(await count('alice', `select count(*) n from public.session_sets where session_id=$1 and reps=7`, [S1]), 1, 're-normalized');
  });
  await test('sync', 'stale base_version → conflict with server copy, never overwrites', async () => {
    const r = ok(await rpc('alice', 'sync_push', { p_entity: 'sessions', p_id: S1, p_op: 'upsert', p_base_version: v1, p_payload: sessionPayload(1) }), 'stale');
    eq([r.status, Number(r.version), r.payload.updatedAt, r.deleted], ['conflict', v2, sessionPayload(7).updatedAt, false], 'conflict');
    const s = await as('alice', `select (payload->>'updatedAt')::bigint u from public.workout_sessions where id=$1`, [S1]);
    eq(Number(s.rows[0].u), sessionPayload(7).updatedAt, 'server kept');
  });
  await test('sync', 'stale delete → conflict (completed sets are not silently lost)', async () => {
    eq(ok(await rpc('alice', 'sync_push', { p_entity: 'sessions', p_id: S1, p_op: 'delete', p_base_version: v1, p_payload: null }), 'del').status, 'conflict', 'status');
  });
  await test('sync', 'other records: measurement, food log, account_state (private profile incl. health)', async () => {
    for (const [entity, id, payload] of [
      ['measurements', M_ID, { id: M_ID, kind: 'bodyweight', date: '2026-10-27', value: 64.2, createdAt: ts, updatedAt: ts }],
      ['food_logs', F_ID, { id: F_ID, date: '2026-10-27', meal: 'lunch', name: 'Skyr', source: { kind: 'quick' }, protein: 20, createdAt: ts, updatedAt: ts }],
      ['account_state', U.alice, accountPayload],
    ]) {
      eq(ok(await rpc('alice', 'sync_push', { p_entity: entity, p_id: id, p_op: 'upsert', p_base_version: null, p_payload: payload }), entity).status, 'ok', entity);
    }
    const a = await as('alice', `select id, payload->>'id' pid, payload#>>'{profile,injuryNotes}' inj from public.account_state`);
    eq(a.rows, [{ id: U.alice, pid: 'account', inj: 'Left shoulder impingement' }], 'account_state keyed by owner');
  });
  await test('sync', 'a program requires its versions array; versions normalized to program_versions', async () => {
    const pid = randomUUID();
    fails(await rpc('alice', 'sync_push', { p_entity: 'programs', p_id: pid, p_op: 'upsert', p_base_version: null, p_payload: { id: pid, name: 'x' } }), 'no versions', /versions/);
    ok(await rpc('alice', 'sync_push', { p_entity: 'programs', p_id: pid, p_op: 'upsert', p_base_version: null,
      p_payload: { id: pid, name: 'Upper/Lower', source: 'generated', startDate: '2026-10-26', active: true, currentVersion: 2,
        versions: [{ version: 1, createdAt: ts, reason: 'Generated', weeks: 6 }, { version: 2, createdAt: ts, reason: 'Swapped bench', weeks: 6 }] } }), 'program');
    eq(await count('alice', `select count(*) n from public.program_versions where program_id=$1`, [pid]), 2, 'versions');
  });
  await test('sync', 'payload id mismatch, unknown entity, unsigned callers are rejected', async () => {
    fails(await rpc('alice', 'sync_push', { p_entity: 'measurements', p_id: randomUUID(), p_op: 'upsert', p_base_version: null, p_payload: { id: randomUUID() } }), 'mismatch', /match/);
    fails(await rpc('alice', 'sync_push', { p_entity: 'profiles', p_id: randomUUID(), p_op: 'upsert', p_base_version: null, p_payload: {} }), 'entity', /Unknown/);
    fails(await rpc('anon', 'sync_push', { p_entity: 'measurements', p_id: randomUUID(), p_op: 'upsert', p_base_version: null, p_payload: {} }), 'anon');
    fails(await rpc('anon', 'sync_pull', { p_since: 0 }), 'anon pull');
  });
  await test('sync', 'direct INSERT/UPDATE/DELETE on private tables is denied even for the owner', async () => {
    fails(await as('alice', `insert into public.measurements (owner_id, id, version, payload) values ($1, $2, 1, '{}')`, [U.alice, randomUUID()]), 'insert');
    fails(await as('alice', `update public.workout_sessions set payload='{}' where id=$1`, [S1]), 'update');
    fails(await as('alice', `delete from public.workout_sessions where id=$1`, [S1]), 'delete');
    fails(await as('alice', `insert into public.measurements (owner_id, id, version, payload) values ($1, $2, 1, '{}')`, [U.bob, randomUUID()]), 'forged owner');
  });
  await test('sync', 'same record id in another account is a separate record (no collision/leak)', async () => {
    const r = ok(await rpc('bob', 'sync_push', { p_entity: 'sessions', p_id: S1, p_op: 'upsert', p_base_version: null, p_payload: { ...sessionPayload(99), name: 'Bob' } }), 'bob push');
    eq(r.status, 'ok', 'bob gets his own row, not alice’s payload');
    const a = await as('alice', `select payload->>'name' n from public.workout_sessions where id=$1`, [S1]);
    eq(a.rows[0].n, 'Upper A', 'alice untouched');
  });
  await test('sync', 'sync_pull returns own changes ascending with cursor/hasMore paging', async () => {
    const p1 = ok(await rpc('alice', 'sync_pull', { p_since: 0, p_limit: 2 }), 'pull');
    eq([p1.changes.length, p1.hasMore], [2, true], 'page 1');
    const vs = p1.changes.map((c) => Number(c.version));
    assert(vs[0] < vs[1] && Number(p1.cursor) === vs[1], 'ascending + cursor');
    let all = [...p1.changes];
    let cur = p1.cursor;
    for (let i = 0; i < 10; i++) {
      const p = ok(await rpc('alice', 'sync_pull', { p_since: cur, p_limit: 2 }), 'pull n');
      all = all.concat(p.changes);
      cur = p.cursor;
      if (!p.hasMore) break;
    }
    eq(all.map((c) => c.entity).sort(), ['account_state', 'food_logs', 'measurements', 'programs', 'sessions'], 'entities');
    assert(all.every((c) => c.entity !== 'sessions' || c.payload.name === 'Upper A'), 'never another account’s rows');
  });
  await test('sync', 'delete with current base → tombstone; later upsert is "gone" (no resurrection)', async () => {
    const d = ok(await rpc('alice', 'sync_push', { p_entity: 'sessions', p_id: S1, p_op: 'delete', p_base_version: v2, p_payload: { ...sessionPayload(7), deletedAt: ts } }), 'delete');
    eq(d.status, 'ok', 'delete ok');
    const again = ok(await rpc('alice', 'sync_push', { p_entity: 'sessions', p_id: S1, p_op: 'delete', p_base_version: v2, p_payload: null }), 'delete retry');
    eq(again.status, 'ok', 'idempotent delete');
    for (const base of [v2, Number(d.version), null]) {
      eq(ok(await rpc('alice', 'sync_push', { p_entity: 'sessions', p_id: S1, p_op: 'upsert', p_base_version: base, p_payload: sessionPayload(3) }), 'resurrect').status, 'gone', `base ${base}`);
    }
    const row = await as('alice', `select deleted_at is not null del, payload ? 'exercises' has_data from public.workout_sessions where id=$1`, [S1]);
    eq(row.rows[0], { del: true, has_data: false }, 'tombstone without data');
    eq(await count('alice', `select count(*) n from public.session_sets where session_id=$1`, [S1]), 0, 'children removed');
    const p = ok(await rpc('alice', 'sync_pull', { p_since: v2 }), 'pull');
    const t = p.changes.find((c) => c.id === S1);
    eq([t?.deleted, t?.payload], [true, null], 'pull reports tombstone');
    // put a live session back for the access matrix
    ok(await rpc('alice', 'sync_push', { p_entity: 'sessions', p_id: randomUUID(), p_op: 'upsert', p_base_version: null, p_payload: { ...sessionPayload(5), id: undefined } }), 'new session');
  });

  // ---- posts, media, likes, comments (AT 9)
  await test('posts', 'alice creates a friends-audience draft with one photo; retry is idempotent', async () => {
    const args = { p_id: P1, p_kind: 'workout', p_audience: 'friends', p_caption: 'Bench day', p_snapshot: snapshot,
      p_media: [{ id: M1, position: 0, width: 1600, height: 1200, description: 'Me benching' }] };
    p1args = args;
    eq(ok(await rpc('alice', 'create_post_draft', args), 'create').status, 'draft', 'draft');
    eq(ok(await rpc('alice', 'create_post_draft', args), 'retry').status, 'draft', 'retry');
    eq(await adminCount(`select count(*) n from public.posts where id=$1`, [P1]), 1, 'posts');
    eq(await adminCount(`select count(*) n from public.post_media where post_id=$1`, [P1]), 1, 'media');
    eq((await admin.query(`select author_id from public.posts where id=$1`, [P1])).rows[0].author_id, U.alice, 'author from auth.uid()');
  });
  await test('posts', 'author cannot be forged (direct insert / update / extra RPC arg)', async () => {
    fails(await as('alice', `insert into public.posts (id, author_id, kind) values ($1, $2, 'text')`, [randomUUID(), U.bob]), 'insert');
    fails(await as('alice', `update public.posts set author_id=$2 where id=$1`, [P1, U.bob]), 'update');
    fails(await rpc('alice', 'create_post_draft', { p_id: randomUUID(), p_kind: 'text', p_audience: 'friends', p_caption: 'x', p_author_id: U.bob }), 'extra arg');
    fails(await rpc('bob', 'create_post_draft', { ...p1args, p_caption: 'hijack' }), 'reuse of someone else’s post id', /in use/);
    eq((await admin.query(`select caption from public.posts where id=$1`, [P1])).rows[0].caption, 'Bench day', 'unchanged');
  });
  await test('posts', 'more than 4 photos / oversized dimensions rejected', async () => {
    const media = [0, 1, 2, 3, 4].map((i) => ({ id: randomUUID(), position: i % 4, width: 10, height: 10 }));
    fails(await rpc('alice', 'create_post_draft', { p_id: randomUUID(), p_kind: 'text', p_audience: 'friends', p_caption: '', p_media: media }), '5 photos', /at most 4/);
    fails(await rpc('alice', 'create_post_draft', { p_id: randomUUID(), p_kind: 'text', p_audience: 'friends', p_caption: '', p_media: [{ id: randomUUID(), position: 0, width: 5000, height: 10 }] }), 'too big', /4096/);
  });
  await test('storage', 'author uploads image+thumb into own folder for own draft (upsert works)', async () => {
    ok(await insertObject('alice', 'post-media', objPath('alice', P1, M1)), 'image');
    ok(await insertObject('alice', 'post-media', objPath('alice', P1, M1, true)), 'thumb');
    ok(await as('alice', `insert into storage.objects (bucket_id, name, owner_id, metadata) values ('post-media', $1, $2, '{"size":2000}')
      on conflict (bucket_id, name) do update set metadata = excluded.metadata, updated_at = now() returning id`, [objPath('alice', P1, M1), U.alice]), 'upsert retry');
  });
  await test('storage', 'uploads outside the rules are denied', async () => {
    fails(await insertObject('alice', 'post-media', `${U.alice}/${P1}/${randomUUID()}.jpg`), 'no media row');
    fails(await insertObject('alice', 'post-media', `${U.bob}/${P1}/${M1}.jpg`), 'other user folder');
    fails(await insertObject('bob', 'post-media', objPath('alice', P1, M1, true).replace('_thumb', '_x')), 'bob into alice folder');
    fails(await as('bob', `insert into storage.objects (bucket_id, name, owner_id) values ('post-media', $1, $2)`, [`${U.bob}/${P1}/${M1}.jpg`, U.bob]), 'bob uses alice post id');
    fails(await as('bob', `update storage.objects set metadata='{}' where name=$1 returning id`, [objPath('alice', P1, M1)]).then((r) => (r.rowCount ? r : { error: new Error('0 rows') })), 'bob overwrite');
  });
  await test('posts', 'friend cannot see a draft before it is published', async () => {
    eq(await count('bob', `select * from public.posts where id=$1`, [P1]), 0, 'row');
    eq(ok(await rpc('bob', 'get_post', { p_post_id: P1 }), 'get'), null, 'rpc');
    denied(await selectObject('bob', 'post-media', objPath('alice', P1, M1)), 'object');
    fails(await rpc('bob', 'like_post', { p_post_id: P1 }), 'like draft');
  });
  await test('posts', 'clients cannot call the service-only publish RPC', async () => {
    fails(await rpc('alice', 'finalize_post_publish', { p_post_id: P1, p_user_id: U.alice, p_media: [] }), 'authenticated');
    fails(await rpc('anon', 'finalize_post_publish', { p_post_id: P1, p_user_id: U.alice, p_media: [] }), 'anon');
  });
  await test('posts', 'service role (finalize-post) refuses incomplete media, then publishes atomically; idempotent', async () => {
    fails(await rpc('service', 'finalize_post_publish', { p_post_id: P1, p_user_id: U.alice, p_media: [] }), 'missing media', /uploading/);
    fails(await rpc('service', 'finalize_post_publish', { p_post_id: P1, p_user_id: U.bob, p_media: [{ id: M1, width: 1600, height: 1200 }] }), 'wrong author');
    eq(ok(await rpc('service', 'finalize_post_publish', { p_post_id: P1, p_user_id: U.alice, p_media: [{ id: M1, width: 1600, height: 1200, bytes: 2000, thumb_bytes: 300 }] }), 'publish').already, false, 'first');
    eq(ok(await rpc('service', 'finalize_post_publish', { p_post_id: P1, p_user_id: U.alice, p_media: [] }), 'again').already, true, 'idempotent');
    eq((await admin.query(`select p.status, m.status ms from public.posts p join public.post_media m on m.post_id=p.id where p.id=$1`, [P1])).rows[0], { status: 'published', ms: 'ready' }, 'state');
    eq(ok(await rpc('alice', 'create_post_draft', p1args), 'draft retry after publish').status, 'published', 'no-op after publish');
  });
  await test('storage', 'no uploads into a post after it is published', async () => {
    fails(await as('alice', `update storage.objects set metadata='{}' where name=$1 returning id`, [objPath('alice', P1, M1)]).then((r) => (r.rowCount ? r : { error: new Error('0 rows') })), 'overwrite published');
  });
  await test('posts', 'only_me post P2 with photo; alice comments on it', async () => {
    ok(await rpc('alice', 'create_post_draft', { p_id: P2, p_kind: 'text', p_audience: 'only_me', p_caption: 'Progress pic', p_media: [{ id: M2, position: 0, width: 800, height: 800 }] }), 'create');
    ok(await insertObject('alice', 'post-media', objPath('alice', P2, M2)), 'image');
    ok(await insertObject('alice', 'post-media', objPath('alice', P2, M2, true)), 'thumb');
    ok(await rpc('service', 'finalize_post_publish', { p_post_id: P2, p_user_id: U.alice, p_media: [{ id: M2, width: 800, height: 800 }] }), 'publish');
    ok(await rpc('alice', 'add_comment', { p_post_id: P2, p_id: C3, p_body: 'note to self' }), 'comment');
  });
  await test('social', 'friend sees P1 in feed with media, can like (once) and comment (idempotent)', async () => {
    const feed = ok(await rpc('bob', 'get_feed', { p_limit: 10 }), 'feed');
    eq(feed.items.map((p) => p.id), [P1], 'bob feed');
    eq(feed.items[0].media.map((m) => m.image_path), [objPath('alice', P1, M1)], 'media paths');
    eq(feed.items[0].author.username, 'alice', 'author info');
    ok(await rpc('bob', 'like_post', { p_post_id: P1 }), 'like');
    ok(await rpc('bob', 'like_post', { p_post_id: P1 }), 'like again');
    fails(await as('bob', `insert into public.likes (post_id, user_id) values ($1, $2)`, [P1, U.bob]), 'direct like insert');
    eq(await adminCount(`select count(*) n from public.likes where post_id=$1`, [P1]), 1, 'one like');
    const c = ok(await rpc('bob', 'add_comment', { p_post_id: P1, p_id: C1, p_body: 'Strong!' }), 'comment');
    ok(await rpc('bob', 'add_comment', { p_post_id: P1, p_id: C1, p_body: 'Strong!' }), 'comment retry');
    eq(c.author_id, U.bob, 'author');
    ok(await rpc('dave', 'add_comment', { p_post_id: P1, p_id: C2, p_body: 'Nice' }), 'dave comment');
    ok(await rpc('bob', 'add_comment', { p_post_id: P1, p_id: C4, p_body: 'spammy' }), 'bob 2nd comment');
    eq(await adminCount(`select count(*) n from public.comments where post_id=$1`, [P1]), 3, 'comments');
    const post = ok(await rpc('bob', 'get_post', { p_post_id: P1 }), 'get');
    eq([post.like_count, post.comment_count, post.liked_by_me], [1, 3, true], 'counts');
    ok(await selectObject('bob', 'post-media', objPath('alice', P1, M1)).then((r) => (r.rows.length === 1 ? r : { error: new Error('not visible') })), 'friend can sign media');
  });
  await test('social', 'feed keyset pagination is stable (no skips/repeats) using the returned cursor verbatim', async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const id = randomUUID();
      ids.push(id);
      ok(await rpc('bob', 'create_post_draft', { p_id: id, p_kind: 'text', p_audience: 'friends', p_caption: `post ${i}` }), 'draft');
      ok(await rpc('service', 'finalize_post_publish', { p_post_id: id, p_user_id: U.bob, p_media: [] }), 'publish');
    }
    const seen = [];
    let cursor = null;
    for (let page = 0; page < 10; page++) {
      const r = ok(await rpc('alice', 'get_feed', { p_cursor_created_at: cursor?.created_at ?? null, p_cursor_id: cursor?.id ?? null, p_limit: 2 }), 'page');
      seen.push(...r.items.map((p) => p.id));
      cursor = r.next;
      if (!cursor) break;
    }
    eq(seen.length, new Set(seen).size, 'no duplicates');
    for (const id of [...ids, P1]) assert(seen.includes(id), 'every post seen');
    eq(seen.slice(0, 5), [...ids].reverse(), 'newest first');
    for (const id of ids) ok(await rpc('bob', 'delete_post', { p_post_id: id }), 'cleanup');
  });
  await test('social', 'alice is notified of like + comments; never of her own actions; like/unlike does not duplicate', async () => {
    ok(await rpc('alice', 'like_post', { p_post_id: P1 }), 'self like');
    ok(await rpc('bob', 'unlike_post', { p_post_id: P1 }), 'unlike');
    ok(await rpc('bob', 'like_post', { p_post_id: P1 }), 'like again');
    const n = ok(await rpc('alice', 'list_notifications'), 'list');
    eq(n.filter((x) => x.type === 'like').map((x) => x.actor.username), ['bob'], 'likes');
    eq(n.filter((x) => x.type === 'comment').length, 3, 'comments');
    assert(n.every((x) => x.actor?.id !== U.alice), 'no self notification');
    eq(await adminCount(`select count(*) n from public.notifications where recipient_id=actor_id`), 0, 'never self');
    assert(ok(await rpc('alice', 'unread_notification_count'), 'count') >= 4, 'unread');
  });
  await test('social', 'server respects the recipient’s notification preferences', async () => {
    const carolAcct = { ...accountPayload, profile: { ...accountPayload.profile, displayName: 'Carol', injuryNotes: 'none' }, settings: { ...accountPayload.settings, notifications: { friendRequests: false, likes: true, comments: true } } };
    ok(await rpc('carol', 'sync_push', { p_entity: 'account_state', p_id: U.carol, p_op: 'upsert', p_base_version: null, p_payload: carolAcct }), 'prefs');
    const id = ok(await rpc('mia', 'send_friend_request', { p_target: U.carol }), 'request').id;
    eq(await adminCount(`select count(*) n from public.notifications where recipient_id=$1 and type='friend_request'`, [U.carol]), 0, 'muted');
    ok(await rpc('carol', 'respond_friend_request', { p_request_id: id, p_accept: false }), 'decline');
  });
  await test('social', 'notifications can only be created by server logic', async () => {
    fails(await as('bob', `insert into public.notifications (recipient_id, actor_id, type) values ($1, $2, 'like')`, [U.alice, U.bob]), 'insert');
  });
  await test('social', 'post author removes a comment on their post; others cannot', async () => {
    fails(await rpc('carol', 'delete_comment', { p_comment_id: C4 }), 'stranger');
    fails(await rpc('dave', 'delete_comment', { p_comment_id: C4 }), 'other commenter');
    ok(await rpc('alice', 'delete_comment', { p_comment_id: C4 }), 'author of post');
    eq(ok(await rpc('bob', 'list_comments', { p_post_id: P1 }), 'list').map((c) => c.id).sort(), [C1, C2].sort(), 'remaining');
  });
  await test('social', 'only the author edits or deletes a post', async () => {
    fails(await rpc('bob', 'update_post', { p_post_id: P1, p_caption: 'hacked' }), 'bob edit', /not found/);
    fails(await rpc('bob', 'delete_post', { p_post_id: P1 }), 'bob delete', /not found/);
    fails(await as('bob', `update public.posts set caption='x' where id=$1`, [P1]), 'direct');
    ok(await rpc('alice', 'update_post', { p_post_id: P1, p_caption: 'Bench day 💪' }), 'alice edit');
    assert((await admin.query(`select edited_at from public.posts where id=$1`, [P1])).rows[0].edited_at, 'edited_at set');
  });
  let reportId;
  await test('moderation', 'friend reports P1; duplicate open report is not duplicated; stranger cannot report invisible post', async () => {
    ok(await rpc('bob', 'report_content', { p_post_id: P1, p_reason: 'inappropriate', p_details: 'test' }), 'report');
    ok(await rpc('bob', 'report_content', { p_post_id: P1, p_reason: 'inappropriate' }), 'again');
    eq(await adminCount(`select count(*) n from public.reports where post_id=$1`, [P1]), 1, 'one open report');
    fails(await rpc('carol', 'report_content', { p_post_id: P1, p_reason: 'spam' }), 'carol', /not found/);
    ok(await rpc('carol', 'report_content', { p_user_id: U.dave, p_reason: 'spam' }), 'report user');
    reportId = (await admin.query(`select id from public.reports where post_id=$1`, [P1])).rows[0].id;
  });

  // ---- blocking (AT 12)
  await test('block', 'alice blocks dave: friendship removed, request impossible, profile hidden both ways', async () => {
    ok(await rpc('alice', 'block_user', { p_other: U.dave }), 'block');
    eq(await adminCount(`select count(*) n from public.friendships where $1 in (requester_id, addressee_id) and $2 in (requester_id, addressee_id)`, [U.alice, U.dave]), 0, 'friendship gone');
    fails(await rpc('dave', 'send_friend_request', { p_target: U.alice }), 'dave → alice', /not found/);
    fails(await rpc('alice', 'send_friend_request', { p_target: U.dave }), 'alice → dave', /Unblock/);
    eq(ok(await rpc('dave', 'get_profile_by_username', { p_username: 'alice' }), 'dave lookup'), null, 'hidden from blocked');
    eq(ok(await rpc('alice', 'get_profile_by_username', { p_username: 'dave' }), 'alice lookup'), null, 'hidden from blocker');
    eq(ok(await rpc('dave', 'get_profile_by_id', { p_user_id: U.alice }), 'dave by id'), null, 'by id');
    eq(ok(await rpc('alice', 'get_profile_by_id', { p_user_id: U.dave }), 'alice by id').relation, 'blocked', 'blocker sees relation');
    eq(ok(await rpc('alice', 'list_blocked'), 'list').map((p) => p.username), ['dave'], 'blocked list');
    eq(await count('dave', `select * from public.blocks`), 0, 'blocked user cannot see block rows');
  });
  await test('block', 'blocked user’s comments are hidden from the blocker', async () => {
    const ids = ok(await rpc('alice', 'list_comments', { p_post_id: P1 }), 'list').map((c) => c.id);
    assert(!ids.includes(C2), 'dave comment hidden');
    eq(await count('alice', `select * from public.comments where id=$1`, [C2]), 0, 'direct');
  });

  // ---- the access-control matrix (AT 10, 11, 12)
  const ACTORS = [['owner', 'alice'], ['friend', 'bob'], ['stranger', 'carol'], ['signed-out', 'anon'], ['blocked', 'dave'], ['moderator', 'mia']];
  const matrix = [];
  const reads = [
    ['P1 friends post (row)', (a) => as(a, `select id from public.posts where id=$1`, [P1]), 'YYNNNY'],
    ['P1 via get_post RPC', async (a) => { const r = await rpc(a, 'get_post', { p_post_id: P1 }); return r.error ? r : { rows: r.value ? [r.value] : [] }; }, 'YYNNNY'],
    ['P1 comments', (a) => as(a, `select id from public.comments where post_id=$1`, [P1]), 'YYNNNY'],
    ['P1 likes', (a) => as(a, `select post_id from public.likes where post_id=$1`, [P1]), 'YYNNNY'],
    ['P1 media rows', (a) => as(a, `select id from public.post_media where post_id=$1`, [P1]), 'YYNNNY'],
    ['P1 storage object (sign)', (a) => selectObject(a, 'post-media', objPath('alice', P1, M1)), 'YYNNNY'],
    ['P1 storage thumb (sign)', (a) => selectObject(a, 'post-media', objPath('alice', P1, M1, true)), 'YYNNNY'],
    ['P2 only_me post', (a) => as(a, `select id from public.posts where id=$1`, [P2]), 'YNNNNN'],
    ['P2 comments', (a) => as(a, `select id from public.comments where post_id=$1`, [P2]), 'YNNNNN'],
    ['P2 media rows', (a) => as(a, `select id from public.post_media where post_id=$1`, [P2]), 'YNNNNN'],
    ['P2 storage object', (a) => selectObject(a, 'post-media', objPath('alice', P2, M2)), 'YNNNNN'],
    ['workout_sessions', (a) => as(a, `select id from public.workout_sessions where owner_id=$1 and deleted_at is null`, [U.alice]), 'YNNNNN'],
    ['session_sets', (a) => as(a, `select id from public.session_sets where owner_id=$1`, [U.alice]), 'YNNNNN'],
    ['measurements', (a) => as(a, `select id from public.measurements where owner_id=$1`, [U.alice]), 'YNNNNN'],
    ['food_logs', (a) => as(a, `select id from public.food_logs where owner_id=$1`, [U.alice]), 'YNNNNN'],
    ['account_state (health)', (a) => as(a, `select payload#>>'{profile,injuryNotes}' from public.account_state where owner_id=$1`, [U.alice]), 'YNNNNN'],
    ['program_versions', (a) => as(a, `select version_no from public.program_versions where owner_id=$1`, [U.alice]), 'YNNNNN'],
    ['sync_pull (alice data)', async (a) => { const r = await rpc(a, 'sync_pull', { p_since: 0 }); return r.error ? r : { rows: r.value.changes.filter((c) => c.payload?.name === 'Upper A' || c.payload?.profile?.injuryNotes === 'Left shoulder impingement') }; }, 'YNNNNN'],
    ['alice notifications', (a) => as(a, `select id from public.notifications where recipient_id=$1`, [U.alice]), 'YNNNNN'],
    ['alice profile row', (a) => as(a, `select id from public.profiles where id=$1`, [U.alice]), 'YYNNNN'],
    ['alice by username', async (a) => { const r = await rpc(a, 'get_profile_by_username', { p_username: 'alice' }); return r.error ? r : { rows: r.value ? [r.value] : [] }; }, 'YYYNNY'],
    ['reports queue', (a) => as(a, `select id from public.reports`), 'NNNNNY'],
    ['list_reports RPC', async (a) => { const r = await rpc(a, 'list_reports'); return r.error ? r : { rows: r.value }; }, 'NNNNNY'],
    ['app_roles', (a) => as(a, `select * from public.app_roles`), 'NNNNNN'],
    ['rate_events (private)', (a) => as(a, `select * from private.rate_events`), 'NNNNNN'],
  ];
  for (const [label, read, expected] of reads) {
    const row = { label, cells: [] };
    for (let i = 0; i < ACTORS.length; i++) {
      const [role, actor] = ACTORS[i];
      const r = await read(actor);
      const allowed = !r.error && r.rows.length > 0;
      const want = expected[i] === 'Y';
      row.cells.push({ role, allowed, want, how: r.error ? 'err' : r.rows.length ? 'rows' : 'none' });
      results.push({ area: 'matrix', name: `${label} — ${role} ${want ? 'CAN' : 'CANNOT'} read`, ok: allowed === want,
        err: allowed === want ? undefined : `got ${allowed ? 'access' : 'no access'} (${r.error?.message ?? r.rows.length + ' rows'})` });
    }
    matrix.push(row);
  }

  // ---- visibility changes (AT 11, 12)
  await test('visibility', 'P1 friends → only_me: friend immediately loses post, comments, likes, media, storage', async () => {
    ok(await rpc('alice', 'update_post', { p_post_id: P1, p_audience: 'only_me' }), 'change');
    eq(await count('bob', `select * from public.posts where id=$1`, [P1]), 0, 'post');
    eq(await count('bob', `select * from public.comments where post_id=$1`, [P1]), 0, 'comments (even his own)');
    eq(await count('bob', `select * from public.likes where post_id=$1`, [P1]), 0, 'likes');
    eq(await count('bob', `select * from public.post_media where post_id=$1`, [P1]), 0, 'media');
    denied(await selectObject('bob', 'post-media', objPath('alice', P1, M1)), 'storage');
    eq(ok(await rpc('bob', 'get_feed'), 'feed').items.length, 0, 'feed');
    eq(ok(await rpc('bob', 'list_comments', { p_post_id: P1 }), 'list'), [], 'list_comments');
    fails(await rpc('bob', 'add_comment', { p_post_id: P1, p_id: randomUUID(), p_body: 'hi' }), 'comment');
    fails(await rpc('bob', 'like_post', { p_post_id: P1 }), 'like');
    eq(ok(await rpc('alice', 'get_feed'), 'alice feed').items.map((p) => p.id).sort(), [P1, P2].sort(), 'owner still sees both');
    ok(await rpc('alice', 'update_post', { p_post_id: P1, p_audience: 'friends' }), 'restore');
    eq(await count('bob', `select * from public.posts where id=$1`, [P1]), 1, 'restored');
  });
  await test('visibility', 'unfriending revokes access; re-friending restores it', async () => {
    ok(await rpc('bob', 'remove_friend', { p_other: U.alice }), 'remove');
    eq(await count('bob', `select * from public.posts where id=$1`, [P1]), 0, 'post');
    denied(await selectObject('bob', 'post-media', objPath('alice', P1, M1)), 'storage');
    eq(await count('bob', `select * from public.profiles where id=$1`, [U.alice]), 0, 'profile row');
    eq(ok(await rpc('alice', 'list_notifications'), 'n').filter((x) => x.type === 'friend_accept' && x.actor.id === U.bob).length, 0, 'accept notification gone');
    const id = ok(await rpc('bob', 'send_friend_request', { p_target: U.alice }), 'req').id;
    ok(await rpc('alice', 'respond_friend_request', { p_request_id: id, p_accept: true }), 'accept');
    eq(await count('bob', `select * from public.posts where id=$1`, [P1]), 1, 'restored');
  });
  await test('visibility', 'unblocking does not restore friendship or access', async () => {
    ok(await rpc('alice', 'unblock_user', { p_other: U.dave }), 'unblock');
    eq(await count('dave', `select * from public.posts where id=$1`, [P1]), 0, 'still no access');
  });
  await test('visibility', 'non-discoverable profile is findable only by friends', async () => {
    ok(await rpc('bob', 'save_my_profile', { p_username: 'bob', p_display_name: 'Bob', p_discoverable: false }), 'hide');
    eq(ok(await rpc('carol', 'get_profile_by_username', { p_username: 'bob' }), 'carol'), null, 'stranger');
    eq(ok(await rpc('carol', 'get_profile_by_id', { p_user_id: U.bob }), 'carol by id'), null, 'stranger by id');
    eq(ok(await rpc('alice', 'get_profile_by_username', { p_username: 'bob' }), 'alice').relation, 'friends', 'friend');
    fails(await rpc('carol', 'send_friend_request', { p_target: U.bob }), 'cannot request hidden profile', /not found/);
  });

  // ---- avatars
  await test('storage', 'avatars: own folder only, readable by those who can see the profile', async () => {
    const name = `${U.alice}/avatar_${randomUUID()}.jpg`;
    ok(await insertObject('alice', 'avatars', name), 'upload');
    fails(await insertObject('bob', 'avatars', name.replace(U.alice, U.bob).replace('avatar_', 'x_')), 'bad name');
    fails(await insertObject('bob', 'avatars', `${U.alice}/avatar_${randomUUID()}.jpg`), 'other folder');
    ok(await rpc('alice', 'set_avatar_path', { p_path: name }), 'set');
    fails(await rpc('alice', 'set_avatar_path', { p_path: `${U.bob}/avatar_${randomUUID()}.jpg` }), 'foreign path');
    assert((await selectObject('bob', 'avatars', name)).rows.length === 1, 'friend');
    assert((await selectObject('carol', 'avatars', name)).rows.length === 1, 'discoverable → stranger may see avatar');
    denied(await selectObject('anon', 'avatars', name), 'anon');
    ok(await rpc('alice', 'block_user', { p_other: U.carol }), 'block carol');
    denied(await selectObject('carol', 'avatars', name), 'blocked');
    ok(await rpc('alice', 'unblock_user', { p_other: U.carol }), 'unblock carol');
  });

  // ---- moderation
  await test('moderation', 'regular users cannot list/resolve reports or grant themselves moderator', async () => {
    fails(await rpc('bob', 'list_reports'), 'list', /moderators/);
    fails(await rpc('bob', 'resolve_report', { p_report_id: reportId, p_action: 'remove_content' }), 'resolve', /moderators/);
    fails(await as('bob', `insert into public.app_roles (user_id, role) values ($1, 'moderator')`, [U.bob]), 'insert app_roles');
    fails(await as('bob', `update public.profiles set display_name='moderator' where id=$1`, [U.bob]), 'profile update');
    fails(await rpc('bob', 'save_my_profile', { p_username: 'bob', p_display_name: 'Bob', p_role: 'moderator' }), 'extra arg');
    ok(await rpc('bob', 'save_my_profile', { p_username: 'bob', p_display_name: 'moderator', p_bio: 'role: moderator' }), 'cosmetic');
    eq(ok(await rpc('bob', 'am_moderator'), 'am'), false, 'still not moderator');
    eq(ok(await rpc('mia', 'am_moderator'), 'am'), true, 'mia is');
    fails(await rpc('bob', 'sync_push', { p_entity: 'app_roles', p_id: U.bob, p_op: 'upsert', p_base_version: null, p_payload: { role: 'moderator' } }), 'via sync');
  });
  await test('moderation', 'moderator lists reports with content and removes the post', async () => {
    const list = ok(await rpc('mia', 'list_reports', { p_status: 'open' }), 'list');
    const r = list.find((x) => x.id === reportId);
    eq([r?.target_kind, r?.content?.caption], ['post', 'Bench day 💪'], 'report content');
    eq(await count('mia', `select * from public.measurements where owner_id=$1`, [U.alice]), 0, 'moderator cannot read private data');
    ok(await rpc('mia', 'resolve_report', { p_report_id: reportId, p_action: 'remove_content' }), 'resolve');
    eq((await admin.query(`select status from public.reports where id=$1`, [reportId])).rows[0].status, 'actioned', 'actioned');
    const p = (await admin.query(`select deleted_at is not null del, removed_by_moderator m from public.posts where id=$1`, [P1])).rows[0];
    eq(p, { del: true, m: true }, 'soft deleted');
    eq(await adminCount(`select count(*) n from public.likes where post_id=$1`, [P1]) + await adminCount(`select count(*) n from public.comments where post_id=$1`, [P1]) + await adminCount(`select count(*) n from public.post_media where post_id=$1`, [P1]), 0, 'likes/comments/media rows removed');
    for (const a of ['alice', 'bob', 'mia']) denied(await selectObject(a, 'post-media', objPath('alice', P1, M1)), `${a} storage after removal`);
    eq(ok(await rpc('alice', 'list_notifications'), 'n').filter((x) => x.post_id === P1).length, 0, 'notifications of deleted post hidden');
    const c = ok(await rpc('service', 'cleanup_media_candidates'), 'cleanup');
    assert(c.deleted.some((x) => x.post_id === P1), 'queued for storage cleanup');
  });
  await test('moderation', 'author deletes own post (soft delete, idempotent)', async () => {
    ok(await rpc('alice', 'delete_post', { p_post_id: P2 }), 'delete');
    ok(await rpc('alice', 'delete_post', { p_post_id: P2 }), 'again');
    eq(await count('alice', `select * from public.posts where id=$1`, [P2]), 0, 'gone for author too');
    fails(await rpc('alice', 'create_post_draft', { p_id: P2, p_kind: 'text', p_audience: 'only_me', p_caption: 'again' }), 'no resurrection via retry', /deleted/);
    ok(await rpc('service', 'cleanup_media_done', { p_deleted: [P1, P2], p_abandoned: [] }), 'mark cleaned');
  });
  await test('cleanup', 'abandoned drafts older than 24 h are listed and removed', async () => {
    const d = randomUUID();
    ok(await rpc('carol', 'create_post_draft', { p_id: d, p_kind: 'text', p_audience: 'friends', p_caption: 'never published' }), 'draft');
    await admin.query(`update public.posts set created_at = now() - interval '25 hours' where id=$1`, [d]);
    const c = ok(await rpc('service', 'cleanup_media_candidates'), 'list');
    assert(c.abandoned.some((x) => x.post_id === d), 'listed');
    fails(await rpc('carol', 'cleanup_media_candidates'), 'client cannot call');
    ok(await rpc('service', 'cleanup_media_done', { p_deleted: [], p_abandoned: [d] }), 'done');
    eq(await adminCount(`select count(*) n from public.posts where id=$1`, [d]), 0, 'removed');
  });

  // ---- abuse limits
  await test('limits', 'more than 30 posts per hour is refused with a clear message', async () => {
    const r = await as('carol', `do $$ begin for i in 1..31 loop perform public.create_post_draft(gen_random_uuid(), 'text', 'friends', 'x'); end loop; end $$`);
    fails(r, '31st post', /posting a lot/);
    const r2 = await as('carol', `do $$ begin for i in 1..29 loop perform public.create_post_draft(gen_random_uuid(), 'text', 'friends', 'x'); end loop; end $$`);
    ok(r2, '29 posts within the limit (1 already used)');
  });
  await test('limits', 'more than 50 friend requests per day is refused', async () => {
    const ids = [];
    for (let i = 0; i < 51; i++) ids.push(randomUUID());
    await admin.query(`insert into auth.users (id) select unnest($1::uuid[])`, [ids]);
    await admin.query(`insert into public.profiles (id, username, display_name) select id, 'bulk_' || row_number() over (), 'Bulk' from unnest($1::uuid[]) id`, [ids]);
    const r = await as('mia', `select count(public.send_friend_request(x)) n from unnest($1::uuid[]) x`, [ids]);
    fails(r, '51st request', /friend requests/);
  });

  // ---- account deletion (AT 15)
  await test('deletion', 'deleting the auth user cascades every owned row (private + social)', async () => {
    ok(await rpc('eve', 'sync_push', { p_entity: 'account_state', p_id: U.eve, p_op: 'upsert', p_base_version: null, p_payload: accountPayload }), 'acct');
    const es = randomUUID();
    ok(await rpc('eve', 'sync_push', { p_entity: 'sessions', p_id: es, p_op: 'upsert', p_base_version: null, p_payload: { ...sessionPayload(4), id: es } }), 'session');
    const rq = ok(await rpc('eve', 'send_friend_request', { p_target: U.alice }), 'req').id;
    ok(await rpc('alice', 'respond_friend_request', { p_request_id: rq, p_accept: true }), 'accept');
    const ep = randomUUID();
    ok(await rpc('eve', 'create_post_draft', { p_id: ep, p_kind: 'text', p_audience: 'friends', p_caption: 'bye' }), 'post');
    ok(await rpc('service', 'finalize_post_publish', { p_post_id: ep, p_user_id: U.eve, p_media: [] }), 'publish');
    ok(await rpc('alice', 'like_post', { p_post_id: ep }), 'alice likes');
    ok(await rpc('alice', 'add_comment', { p_post_id: ep, p_id: randomUUID(), p_body: 'see you' }), 'alice comments');
    ok(await rpc('eve', 'report_content', { p_user_id: U.carol, p_reason: 'other' }), 'report');
    // what the delete-account Edge Function does after removing storage objects: auth.admin.deleteUser
    await admin.query(`delete from auth.users where id=$1`, [U.eve]);
    const tables = ['account_state', 'workout_sessions', 'session_exercises', 'session_sets', 'programs', 'measurements', 'food_logs'];
    for (const t of tables) eq(await adminCount(`select count(*) n from public.${t} where owner_id=$1`, [U.eve]), 0, t);
    eq(await adminCount(`select count(*) n from public.profiles where id=$1`, [U.eve]), 0, 'profile');
    eq(await adminCount(`select count(*) n from public.posts where author_id=$1`, [U.eve]), 0, 'posts');
    eq(await adminCount(`select count(*) n from public.likes where post_id=$1`, [ep]), 0, 'likes on her post');
    eq(await adminCount(`select count(*) n from public.friendships where $1 in (requester_id, addressee_id)`, [U.eve]), 0, 'friendships');
    eq(await adminCount(`select count(*) n from public.notifications where $1 in (recipient_id, actor_id)`, [U.eve]), 0, 'notifications');
    eq(await adminCount(`select count(*) n from public.reports where reporter_id=$1`, [U.eve]), 0, 'reports');
    eq(await adminCount(`select count(*) n from private.rate_events where user_id=$1`, [U.eve]), 0, 'rate events');
    eq(ok(await rpc(U.eve, 'sync_pull', { p_since: 0 }), 'stale token pull').changes.length, 0, 'stale JWT sees nothing');
    fails(await rpc(U.eve, 'sync_push', { p_entity: 'measurements', p_id: randomUUID(), p_op: 'upsert', p_base_version: null, p_payload: {} }), 'stale JWT cannot write');
  });
  await test('deletion', 'export_my_data returns own records only', async () => {
    const e = ok(await rpc('alice', 'export_my_data'), 'export');
    eq([e.measurements.length, e.food_logs.length, e.account_state.length], [1, 1, 1], 'counts');
    eq(e.profile.username, 'alice', 'profile');
    assert(e.posts.every((p) => p.author_id === U.alice), 'own posts only');
  });

  // ---- reference data
  await test('reference', 'reference catalogs are readable by anon and authenticated, writable by nobody', async () => {
    const n = await count('anon', `select count(*) n from public.ref_exercises`);
    assert(n >= (fs.existsSync(path.join(ROOT, 'supabase/seed.sql')) ? 60 : 0), `anon reads seeded exercises (${n})`);
    ok(await as('carol', `select count(*) from public.ref_recipes`), 'auth read');
    fails(await as('carol', `insert into public.ref_exercises (id, name, category, pattern, tracking, load_convention, data) values ('x','x','x','x','x','x','{}')`), 'insert');
    fails(await as('anon', `delete from public.ref_ingredients`), 'delete');
  });

  printMatrix(matrix, ACTORS);

  // ---- coaching (brief §10 items 1–8); independent of …03_ai_coach.sql
  if (coachingReady) {
    const cm = await coachingTests({ test, rpc, as, admin, ok, fails, eq, assert, count, adminCount, results });
    console.log('\nCoaching access matrix');
    printMatrix(cm.matrix, cm.actors);
    // backend audit (repair brief §7): own actors, runs last
    const connect = async () => {
      const c = new pg.Client({ host: 'localhost', port: PORT, user: 'postgres', database: 'postgres' });
      await c.connect();
      return c;
    };
    await auditTests({ test, rpc, as, admin, ok, fails, eq, assert, count, adminCount, results, connect });
    // public (signed-out) coach preview: own actors
    await publicCoachPreviewTests({ test, rpc, as, admin, ok, fails, eq, assert });
  } else {
    results.push({ area: 'coaching', name: 'coaching migrations applied', ok: false, err: 'skipped: a coaching migration failed to apply' });
  }
}

function printMatrix(matrix, actors) {
  const w = Math.max(...matrix.map((r) => r.label.length), 10);
  console.log('\nAccess-control matrix (Y = can read, · = cannot; ✗ marks a mismatch with the expectation)\n');
  console.log(`${'resource'.padEnd(w)} | ${actors.map(([r]) => r.padEnd(10)).join(' ')}`);
  console.log(`${'-'.repeat(w)}-+-${actors.map(() => '-'.repeat(10)).join(' ')}`);
  for (const row of matrix) {
    console.log(`${row.label.padEnd(w)} | ${row.cells.map((c) => `${c.allowed ? 'Y' : '·'}${c.allowed === c.want ? '' : ' ✗'}`.padEnd(10)).join(' ')}`);
  }
}

let p1args;
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
console.log('\nResults\n');
const aw = Math.max(...results.map((r) => r.area.length));
for (const r of results) {
  if ((r.area === 'matrix' || r.area === 'coach matrix') && r.ok) continue; // shown in the matrices above
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.area.padEnd(aw)}  ${r.name}${r.ok ? '' : `\n        → ${r.err}`}`);
}
const mx = results.filter((r) => r.area === 'matrix' || r.area === 'coach matrix');
console.log(`\nmatrix cells: ${mx.filter((r) => r.ok).length}/${mx.length} as expected`);
console.log(`\n${fail === 0 ? 'ALL PASSED' : 'FAILURES'}: ${pass} passed, ${fail} failed, ${results.length} total`);
if (fail) exitCode = 1;
process.exit(exitCode);
