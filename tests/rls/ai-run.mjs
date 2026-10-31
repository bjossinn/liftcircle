#!/usr/bin/env node
/**
 * training assistant database authorization tests: `node tests/rls/ai-run.mjs`
 *
 * Same approach as tests/rls/run.mjs: a throwaway PostgreSQL 16 cluster, tests/rls/supabase-stub.sql,
 * then EVERY migration in supabase/migrations applied in order as the non-superuser `postgres` role, and
 * requests simulated with `set local role authenticated|anon|service_role` + request.jwt.claims.
 * Covers: ai_settings / ai_messages / ai_usage RLS, consent rules, service-only RPCs, idempotent
 * ai_record_exchange, AI proposals (list/respond, stale check, coach-review target), usage limit (PT429),
 * clear history, account deletion cascade.
 *
 * Env: PG_BIN (default /usr/lib/postgresql/16/bin), AI_PG_PORT (default 54339), RLS_KEEP=1 keeps the cluster dir.
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
const PORT = Number(process.env.AI_PG_PORT || 54339);
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-ai-'));
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

const ts = Date.now();
const PROG = randomUUID();
const programPayload = (cur) => ({
  id: PROG, name: 'Alice plan', source: 'generated', startDate: '2026-09-01', active: true, currentVersion: cur,
  rotationIndex: 0, overrides: [], createdAt: ts, updatedAt: ts + cur,
  versions: Array.from({ length: cur }, (_, i) => ({ version: i + 1, createdAt: ts, reason: 'x', templates: [], schedule: [], weeks: 8, reviewWeek: 4, rationale: [], warnings: [] })),
});
const proposedProgram = { name: 'AI plan', templates: [{ id: 't1', name: 'Full body', exercises: [] }], schedule: [], weeks: 4, reviewWeek: 4, rationale: [], warnings: [], reason: 'AI' };
const exchange = (id, content, proposal = null) => ({
  p_user: [null, ''],
  p_message: J({ id, content, mode: 'chat' }),
  p_reply: J({ content: `reply to ${content}`, grounding: ['Active plan'], model: 'claude-test', inputTokens: 1200, outputTokens: 300 }),
  p_proposal: J(proposal),
  p_usage: J({ inputTokens: 1200, outputTokens: 300, costUsd: 0.0054 }),
});
const withUser = (user, a) => ({ ...a, p_user: [user, '::uuid'] });

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
    assert(migrations.includes('20261029000003_ai_coach.sql'), 'ai migration present');
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

  for (const [name, id] of Object.entries(U)) {
    await admin.query(`insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())`, [id, `${name}@example.test`]);
  }

  await test('setup', 'RLS on every public table; no client write grants; definer functions pinned and not anon-executable', async () => {
    const r1 = await admin.query(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
    eq(r1.rows.map((x) => x.relname), [], 'tables without RLS');
    const r2 = await admin.query(`select table_name, grantee, privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and table_name like 'ai\\_%' and grantee in ('anon','authenticated','PUBLIC') and privilege_type <> 'SELECT'`);
    eq(r2.rows, [], 'write grants on ai tables');
    const r3 = await admin.query(`select table_name from information_schema.role_table_grants
      where table_schema = 'public' and table_name like 'ai\\_%' and grantee = 'anon'`);
    eq(r3.rows, [], 'anon grants on ai tables');
    const r4 = await admin.query(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','private') and p.prosecdef and (p.proname like '%ai\\_%')
        and (not coalesce(p.proconfig, '{}') && array['search_path=""', 'search_path='] or has_function_privilege('anon', p.oid, 'execute'))`);
    eq(r4.rows.map((x) => x.proname), [], 'ai functions missing search_path or anon-executable');
  });

  await test('privileges', 'service-only RPCs are not executable by authenticated or anon', async () => {
    for (const actor of ['alice', 'anon']) {
      fails(await rpc(actor, 'ai_record_exchange', withUser(U[actor] ?? U.alice, exchange(randomUUID(), 'hi'))), `${actor} ai_record_exchange`, /permission denied/);
      fails(await rpc(actor, 'ai_check_and_count_usage', { p_user: [U.alice, '::uuid'], p_limit: 5 }), `${actor} usage`, /permission denied/);
      fails(await rpc(actor, 'ai_get_exchange', { p_user: [U.alice, '::uuid'], p_message_id: [randomUUID(), '::uuid'] }), `${actor} get exchange`, /permission denied/);
    }
    fails(await as('alice', `select private.ai_settings_json(null::public.ai_settings)`), 'private helper', /permission denied/);
  });

  await test('privileges', 'anon cannot call client AI RPCs or read AI tables', async () => {
    fails(await rpc('anon', 'get_ai_settings'), 'anon get', /permission denied/);
    fails(await rpc('anon', 'save_ai_settings', { p: J({ enabled: true, acceptConsent: true }) }), 'anon save', /permission denied/);
    for (const t of ['ai_settings', 'ai_messages', 'ai_usage']) assert((await visible('anon', `select * from public.${t}`)) <= 0, `anon reads ${t}`);
  });

  /* ------------------------------------------------------------ settings */
  await test('settings', 'no settings yet → null; enabling without consent is refused', async () => {
    eq(ok(await rpc('alice', 'get_ai_settings'), 'get'), null, 'initial');
    fails(await rpc('alice', 'save_ai_settings', { p: J({ enabled: true }) }), 'enable w/o consent', /agree|consent_required/);
    fails(await as('alice', `insert into public.ai_settings (user_id, enabled, consent_at) values ($1, true, now())`, [U.alice]), 'direct insert', /permission denied/);
  });
  let changedAt;
  await test('settings', 'consent + enable works; client cannot set consentAt/scopesChangedAt; notes limit', async () => {
    const s = ok(await rpc('alice', 'save_ai_settings', { p: J({ enabled: true, acceptConsent: true, profileNotes: 'Morning person', consentAt: '2000-01-01T00:00:00Z', scopesChangedAt: '2000-01-01T00:00:00Z', userId: U.bob }) }), 'enable');
    assert(s.enabled && s.consentAt && !s.consentAt.startsWith('2000'), 'consent set by server');
    assert(!s.scopesChangedAt.startsWith('2000'), 'scopesChangedAt not client-settable');
    changedAt = s.scopesChangedAt;
    eq(sc(s.scopes), sc({ profile: true, training: true, measurements: false, nutrition: false }), 'default scopes');
    eq(s.profileNotes, 'Morning person', 'notes');
    fails(await rpc('alice', 'save_ai_settings', { p: J({ profileNotes: 'x'.repeat(4001) }) }), 'notes > 4000', /4000/);
    fails(await rpc('alice', 'save_ai_settings', { p: J({ scopes: { nutrition: 'yes' } }) }), 'non-boolean scope', /true or false/);
    eq(ok(await rpc('bob', 'get_ai_settings'), 'bob get'), null, 'bob unaffected by userId in body');
  });
  await test('settings', 'changing scopes bumps scopes_changed_at; unchanged scopes do not', async () => {
    await new Promise((r) => setTimeout(r, 20));
    const same = ok(await rpc('alice', 'save_ai_settings', { p: J({ scopes: { profile: true } }) }), 'same');
    eq(same.scopesChangedAt, changedAt, 'no bump when unchanged');
    const s = ok(await rpc('alice', 'save_ai_settings', { p: J({ scopes: { training: false, nutrition: true } }) }), 'change');
    assert(new Date(s.scopesChangedAt) > new Date(changedAt), 'bumped');
    eq(sc(s.scopes), sc({ profile: true, training: false, measurements: false, nutrition: true }), 'merged');
    const p = ok(await rpc('alice', 'save_ai_settings', { p: J({ paused: true }) }), 'pause');
    assert(p.paused && p.enabled, 'paused');
    ok(await rpc('alice', 'save_ai_settings', { p: J({ paused: false, scopes: { training: true } }) }), 'resume');
  });
  await test('settings', 'coach style: defaults to balanced, saves a valid style, refuses unknown values, own row only, no direct write', async () => {
    const before = ok(await rpc('alice', 'get_ai_settings'), 'get');
    eq(before.coachStyle, 'balanced', 'default');
    const s = ok(await rpc('alice', 'save_ai_settings', { p: J({ coachStyle: 'strict' }) }), 'strict');
    eq(s.coachStyle, 'strict', 'saved');
    eq(s.scopesChangedAt, before.scopesChangedAt, 'style change does not touch scopes_changed_at');
    eq(s.profileNotes, before.profileNotes, 'notes untouched');
    fails(await rpc('alice', 'save_ai_settings', { p: J({ coachStyle: 'drill-sergeant' }) }), 'unknown style', /supportive, balanced or strict/);
    fails(await rpc('alice', 'save_ai_settings', { p: J({ coachStyle: 3 }) }), 'non-string style', /supportive, balanced or strict/);
    eq(ok(await rpc('alice', 'get_ai_settings'), 'get').coachStyle, 'strict', 'refused values change nothing');
    fails(await as('alice', `update public.ai_settings set coach_style = 'supportive' where user_id = $1`, [U.alice]), 'direct update', /permission denied/);
    eq((await admin.query(`select coach_style from public.ai_settings where user_id = $1`, [U.alice])).rows[0].coach_style, 'strict', 'stored');
    eq(ok(await rpc('bob', 'get_ai_settings'), 'bob get'), null, 'bob unaffected');
    ok(await rpc('alice', 'save_ai_settings', { p: J({ coachStyle: 'balanced' }) }), 'back to balanced');
  });

  /* ------------------------------------------------------------ exchanges */
  const M1 = randomUUID();
  const M2 = randomUUID();
  let reply1;
  let prop1;
  await test('exchange', 'service records an exchange atomically (user msg + reply + proposal + usage)', async () => {
    ok(await rpc('alice', 'sync_push', { p_entity: 'programs', p_id: [PROG, '::uuid'], p_op: 'upsert', p_base_version: null, p_payload: J(programPayload(3)) }), 'seed program v3');
    const r = ok(await rpc('service', 'ai_record_exchange', withUser(U.alice, exchange(M1, 'Make my plan harder', {
      baseProgramId: PROG, baseVersion: 1, program: proposedProgram, changeSummary: ['More sets'], message: 'Try this', target: 'apply', validationErrors: [],
    }))), 'record');
    eq(r.duplicate, false, 'first');
    reply1 = r.reply;
    prop1 = r.proposal;
    eq([r.reply.role, r.reply.content, r.reply.proposalId], ['assistant', 'reply to Make my plan harder', r.proposal.id], 'reply');
    eq([r.proposal.authorKind, r.proposal.status, r.proposal.clientId, r.proposal.relationshipId, r.proposal.coachId, r.proposal.revision], ['ai', 'sent', U.alice, null, null, 1], 'proposal');
    const u = await admin.query(`select requests, input_tokens, output_tokens, cost_usd from public.ai_usage where user_id = $1`, [U.alice]);
    eq([Number(u.rows[0].input_tokens), Number(u.rows[0].output_tokens), Number(u.rows[0].cost_usd)], [1200, 300, 0.0054], 'usage tokens');
  });
  await test('exchange', 'idempotent on the user message id; id owned by another user is refused', async () => {
    const r = ok(await rpc('service', 'ai_record_exchange', withUser(U.alice, exchange(M1, 'Make my plan harder'))), 'repeat');
    eq([r.duplicate, r.reply.id, r.proposal?.id], [true, reply1.id, prop1.id], 'same stored exchange');
    const n = await admin.query(`select count(*)::int n from public.ai_messages where user_id = $1`, [U.alice]);
    eq(n.rows[0].n, 2, 'no duplicate rows');
    fails(await rpc('service', 'ai_record_exchange', withUser(U.bob, exchange(M1, 'steal'))), 'bob reuses id', /already used/);
    const g = ok(await rpc('service', 'ai_get_exchange', { p_user: [U.alice, '::uuid'], p_message_id: [M1, '::uuid'] }), 'lookup');
    eq(g.reply.id, reply1.id, 'lookup returns stored reply');
    eq(ok(await rpc('service', 'ai_get_exchange', { p_user: [U.bob, '::uuid'], p_message_id: [M1, '::uuid'] }), 'bob lookup'), null, 'not for bob');
    ok(await rpc('service', 'ai_record_exchange', withUser(U.bob, exchange(M2, 'Bob question'))), 'bob exchange');
  });
  await test('exchange', 'invalid proposals are stored as invalid with their errors', async () => {
    const r = ok(await rpc('service', 'ai_record_exchange', withUser(U.alice, exchange(randomUUID(), 'Use the barbell', {
      baseProgramId: PROG, baseVersion: 3, program: proposedProgram, changeSummary: ['x'], target: 'apply', validationErrors: ['needs equipment you haven\'t listed'],
    }))), 'record invalid');
    eq([r.proposal.status, r.proposal.validationErrors, r.proposal.sentAt], ['invalid', ['needs equipment you haven\'t listed'], null], 'invalid');
  });

  /* ------------------------------------------------------------ RLS reads */
  await test('rls', 'users read only their own AI messages, settings, usage and proposals', async () => {
    eq((ok(await rpc('alice', 'list_ai_messages', { p_limit: 50 }), 'alice list')).length, 4, 'alice messages');
    const bobMsgs = ok(await rpc('bob', 'list_ai_messages', { p_limit: 50 }), 'bob list');
    eq(bobMsgs.map((m) => m.content), ['Bob question', 'reply to Bob question'], 'bob sees only his');
    eq(await visible('bob', `select * from public.ai_messages where user_id = $1`, [U.alice]), 0, 'bob table read of alice');
    eq(await visible('bob', `select * from public.ai_settings where user_id = $1`, [U.alice]), 0, 'bob reads alice settings');
    eq(await visible('bob', `select * from public.ai_usage where user_id = $1`, [U.alice]), 0, 'bob reads alice usage');
    eq(await visible('alice', `select * from public.ai_usage`), 1, 'alice reads own usage');
    eq((ok(await rpc('bob', 'list_ai_proposals'), 'bob proposals')).length, 0, 'bob proposals');
    eq((ok(await rpc('alice', 'list_ai_proposals'), 'alice proposals')).length, 2, 'alice proposals');
    eq(await visible('bob', `select * from public.program_proposals where client_id = $1`, [U.alice]), 0, 'bob reads alice proposals');
    fails(await as('alice', `update public.ai_messages set content = 'x' where user_id = $1`, [U.alice]), 'direct update', /permission denied/);
    fails(await as('alice', `delete from public.ai_usage`), 'direct delete usage', /permission denied/);
  });

  /* ------------------------------------------------------------ proposals */
  await test('proposals', 'other users cannot respond; accept needs program/version; stale base version refused', async () => {
    fails(await rpc('bob', 'respond_ai_proposal', { p_id: [prop1.id, '::uuid'], p_accept: true, p_program_id: [PROG, '::uuid'], p_version: 4 }), 'bob responds', /not found/i);
    fails(await rpc('alice', 'respond_ai_proposal', { p_id: [prop1.id, '::uuid'], p_accept: true }), 'missing program', /program and version/);
    // Proposal was written for v1; the synced plan is now v3 and the client claims it applied v2 → stale.
    fails(await rpc('alice', 'respond_ai_proposal', { p_id: [prop1.id, '::uuid'], p_accept: true, p_program_id: [PROG, '::uuid'], p_version: 2 }), 'stale', /stale/);
    fails(await rpc('alice', 'respond_ai_proposal', { p_id: [prop1.id, '::uuid'], p_accept: true, p_program_id: [randomUUID(), '::uuid'], p_version: 2 }), 'wrong program', /different plan/);
    eq((ok(await rpc('alice', 'list_ai_proposals'), 'list')).find((p) => p.id === prop1.id).status, 'sent', 'still open after refusals');
  });
  await test('proposals', 'a current proposal can be accepted (before or after the applied version syncs); idempotent; older ones superseded', async () => {
    const r = ok(await rpc('service', 'ai_record_exchange', withUser(U.alice, exchange(randomUUID(), 'v3 update', {
      baseProgramId: PROG, baseVersion: 3, program: proposedProgram, changeSummary: ['x'], target: 'apply', validationErrors: [],
    }))), 'record v3 proposal');
    const list = ok(await rpc('alice', 'list_ai_proposals'), 'list');
    eq(list.find((p) => p.id === prop1.id).status, 'superseded', 'older open proposal superseded by the new valid one');
    eq(r.proposal.revision, 3, 'revision counts AI proposals for the same plan');
    // applied locally as v4, not yet synced (server still at v3 = base) → accepted
    const a = ok(await rpc('alice', 'respond_ai_proposal', { p_id: [r.proposal.id, '::uuid'], p_accept: true, p_program_id: [PROG, '::uuid'], p_version: 4 }), 'accept');
    eq([a.status, a.appliedProgramId, a.appliedVersion], ['accepted', PROG, 4], 'accepted');
    ok(await rpc('alice', 'respond_ai_proposal', { p_id: [r.proposal.id, '::uuid'], p_accept: true, p_program_id: [PROG, '::uuid'], p_version: 4 }), 'idempotent repeat');
    fails(await rpc('alice', 'respond_ai_proposal', { p_id: [r.proposal.id, '::uuid'], p_accept: false }), 'decline after accept', /no longer open/);
    // queued accept arriving after the applied version synced (server v4 == applied) is also fine
    const r2 = ok(await rpc('service', 'ai_record_exchange', withUser(U.alice, exchange(randomUUID(), 'another', {
      baseProgramId: PROG, baseVersion: 3, program: proposedProgram, changeSummary: ['y'], target: 'apply', validationErrors: [],
    }))), 'record');
    const cur = (await admin.query(`select version from public.programs where id = $1`, [PROG])).rows[0].version;
    ok(await rpc('alice', 'sync_push', { p_entity: 'programs', p_id: [PROG, '::uuid'], p_op: 'upsert', p_base_version: cur, p_payload: J(programPayload(4)) }), 'sync v4');
    eq((ok(await rpc('alice', 'respond_ai_proposal', { p_id: [r2.proposal.id, '::uuid'], p_accept: true, p_program_id: [PROG, '::uuid'], p_version: 4 }), 'accept synced')).status, 'accepted', 'accepted after sync');
  });
  await test('proposals', 'for_coach_review proposals and invalid proposals cannot be accepted; decline works', async () => {
    const r = ok(await rpc('service', 'ai_record_exchange', withUser(U.alice, exchange(randomUUID(), 'coach plan', {
      baseProgramId: PROG, baseVersion: 4, program: proposedProgram, changeSummary: ['z'], target: 'for_coach_review', validationErrors: [],
    }))), 'record');
    fails(await rpc('alice', 'respond_ai_proposal', { p_id: [r.proposal.id, '::uuid'], p_accept: true, p_program_id: [PROG, '::uuid'], p_version: 5 }), 'coach review accept', /discuss with your coach|not_applicable/);
    eq((ok(await rpc('alice', 'respond_ai_proposal', { p_id: [r.proposal.id, '::uuid'], p_accept: false }), 'decline')).status, 'declined', 'declined');
    const inv = (ok(await rpc('alice', 'list_ai_proposals'), 'list')).find((p) => p.status === 'invalid');
    fails(await rpc('alice', 'respond_ai_proposal', { p_id: [inv.id, '::uuid'], p_accept: true, p_program_id: [PROG, '::uuid'], p_version: 5 }), 'invalid accept', /no longer open/);
    fails(await rpc('alice', 'respond_program_proposal', { p_id: [inv.id, '::uuid'], p_accept: true, p_program_id: [PROG, '::uuid'], p_version: 5 }), 'coach RPC on ai row', /not found/i);
  });

  /* ------------------------------------------------------------ usage limit */
  await test('usage', 'daily request limit: counts, then PT429', async () => {
    eq(ok(await rpc('service', 'ai_check_and_count_usage', { p_user: [U.bob, '::uuid'], p_limit: 2 }), 'first'), 1, 'remaining after 1');
    eq(ok(await rpc('service', 'ai_check_and_count_usage', { p_user: [U.bob, '::uuid'], p_limit: 2 }), 'second'), 0, 'remaining after 2');
    fails(await rpc('service', 'ai_check_and_count_usage', { p_user: [U.bob, '::uuid'], p_limit: 2 }), 'third', /PT429|limit/);
    const n = await admin.query(`select requests from public.ai_usage where user_id = $1`, [U.bob]);
    eq(n.rows[0].requests, 2, 'not incremented past the limit');
    fails(await rpc('service', 'ai_check_and_count_usage', { p_user: [U.bob, '::uuid'], p_limit: 0 }), 'zero limit', /PT429|limit/);
  });

  /* ------------------------------------------------------------ v2: why + this-week action (20261030000002) */
  await test('exchange-v2', 'stores why + week_adjustment action with the reply; replay and history return them; other kinds dropped', async () => {
    const MW = randomUUID();
    const action = { kind: 'week_adjustment', id: MW, baseProgramId: PROG, baseVersion: 3, weekStart: '2026-10-26', weekEnd: '2026-11-01', targetSessions: 2, completed: [{ date: '2026-10-26', name: 'Full body A' }], sessions: [{ templateId: 'B', name: 'Full body B', date: '2026-10-29', plannedDate: '2026-10-28' }], skipped: [{ templateId: 'C', name: 'Full body C', plannedDate: '2026-10-30' }], adjustments: [], warnings: [], summary: '' };
    const base = exchange(MW, 'I can only train twice this week');
    const args = { ...base, p_reply: J({ content: 'Do Full body B on Thursday.', why: 'Monday counts as one of the two.', action, grounding: [], model: 'm', inputTokens: 1, outputTokens: 1 }) };
    const r = ok(await rpc('service', 'ai_record_exchange', withUser(U.alice, args)), 'record v2');
    eq([r.reply.why, r.reply.action?.kind, r.reply.action?.sessions?.[0]?.templateId], ['Monday counts as one of the two.', 'week_adjustment', 'B'], 'returned');
    const again = ok(await rpc('service', 'ai_record_exchange', withUser(U.alice, args)), 'replay');
    eq([again.duplicate, again.reply.id, again.reply.action?.id], [true, r.reply.id, MW], 'idempotent replay keeps the action');
    const list = ok(await rpc('alice', 'list_ai_messages', { p_limit: 200 }), 'history');
    const row = list.find((m) => m.id === r.reply.id);
    eq([row.why, row.action?.kind], ['Monday counts as one of the two.', 'week_adjustment'], 'history');
    const n = await admin.query(`select count(*)::int n from public.ai_messages where reply_to = $1`, [MW]);
    eq(n.rows[0].n, 1, 'one reply row');
    const r2 = ok(await rpc('service', 'ai_record_exchange', withUser(U.alice, { ...exchange(randomUUID(), 'x'), p_reply: J({ content: 'ok', why: '   ', action: { kind: 'rewrite_plan', x: 1 } }) })), 'other kind');
    eq([r2.reply.why, r2.reply.action], [null, null], 'blank why and unknown action kinds are not stored');
    fails(await rpc('alice', 'ai_record_exchange', withUser(U.alice, args)), 'client cannot call v2 record', /permission denied/);
    fails(await as('alice', `update public.ai_messages set action = '{"kind":"week_adjustment"}'::jsonb where id = $1`, [r.reply.id]), 'client cannot write action', /permission denied/);
  });

  /* ------------------------------------------------------------ v4: meal plan + recipe card actions (20261102000001) */
  await test('exchange-v4', 'stores meal_plan and recipe_suggestions actions; replay and history return them to the owner only; unknown kinds still dropped', async () => {
    const MP = randomUUID();
    const RS = randomUUID();
    const mealPlan = { kind: 'meal_plan', id: MP, weekStart: '2026-10-26', weekEnd: '2026-11-01', targets: { proteinG: 150, kcal: null }, summary: 'Friday lunch', warnings: [],
      days: [{ date: '2026-10-30', items: [{ slot: 'lunch', recipeId: 'chicken-rice-bowl', name: 'Chicken rice bowl', servings: 1.5 }] }] };
    const recipes = { kind: 'recipe_suggestions', id: RS, recipes: [{ id: 'greek-yogurt-bowl', name: 'Greek yogurt bowl', meal: 'breakfast', totalMinutes: 5, perServing: { kcal: 350, protein_g: 30, carbs_g: 40, fat_g: 8 } }] };
    const rec = async (id, action) => ok(await rpc('service', 'ai_record_exchange', withUser(U.alice, { ...exchange(id, `q ${id}`), p_reply: J({ content: 'Here you go.', action, grounding: [], model: 'm', inputTokens: 1, outputTokens: 1 }) })), `record ${action.kind}`);
    const r1 = await rec(MP, mealPlan);
    const r2 = await rec(RS, recipes);
    eq([r1.reply.action?.kind, r1.reply.action?.days?.[0]?.items?.[0]?.servings], ['meal_plan', 1.5], 'meal plan returned');
    eq([r2.reply.action?.kind, r2.reply.action?.recipes?.[0]?.id], ['recipe_suggestions', 'greek-yogurt-bowl'], 'recipes returned');
    const again = ok(await rpc('service', 'ai_record_exchange', withUser(U.alice, { ...exchange(MP, `q ${MP}`), p_reply: J({ content: 'changed', action: recipes }) })), 'replay');
    eq([again.duplicate, again.reply.action?.kind], [true, 'meal_plan'], 'idempotent replay keeps the stored action');
    const mine = ok(await rpc('alice', 'list_ai_messages', { p_limit: 200 }), 'alice history');
    eq(['meal_plan', 'recipe_suggestions'].map((k) => mine.some((m) => m.action?.kind === k)), [true, true], 'owner sees both kinds');
    const bobs = ok(await rpc('bob', 'list_ai_messages', { p_limit: 200 }), 'bob history');
    assert(!JSON.stringify(bobs).includes(MP) && !bobs.some((m) => m.action?.kind === 'meal_plan' || m.action?.kind === 'recipe_suggestions'), 'bob sees none of them');
    assert((await visible('bob', `select id from public.ai_messages where reply_to = any($1::uuid[])`, [[MP, RS]])) <= 0, 'bob cannot read the rows directly');
    assert((await visible('anon', `select id from public.ai_messages where reply_to = any($1::uuid[])`, [[MP, RS]])) <= 0, 'anon cannot read the rows');
    const r3 = await rec(randomUUID(), { kind: 'custom_recipe', name: 'x' });
    eq(r3.reply.action, null, 'unknown kinds are not stored');
    fails(await as('alice', `update public.ai_messages set action = '{"kind":"meal_plan"}'::jsonb where id = $1`, [r1.reply.id]), 'client cannot write action', /permission denied/);
  });

  /* ------------------------------------------------------------ export (portability) */
  await test('export', 'export_my_data includes the caller\'s AI settings, messages, usage and AI proposals — and nobody else\'s', async () => {
    const e = ok(await rpc('alice', 'export_my_data'), 'alice export');
    assert(e.ai, 'ai section present');
    assert(e.ai.settings?.enabled === true && e.ai.settings.profile_notes === 'Morning person' && !('user_id' in e.ai.settings), 'settings');
    eq(e.ai.messages.filter((m) => m.role === 'user').map((m) => m.content).includes('Make my plan harder'), true, 'user messages');
    assert(e.ai.messages.some((m) => m.role === 'assistant' && m.reply_to), 'assistant replies');
    assert(e.ai.usage.length === 1 && Number(e.ai.usage[0].input_tokens) > 0, 'usage');
    assert(e.ai.proposals.length >= 3 && e.ai.proposals.every((p) => p.clientId === U.alice && p.authorKind === 'ai'), 'ai proposals');
    const b = ok(await rpc('bob', 'export_my_data'), 'bob export');
    assert(!JSON.stringify(b.ai).includes('Make my plan harder') && b.ai.proposals.length === 0 && b.ai.settings === null, 'bob gets only his own');
    eq(b.ai.messages.map((m) => m.content), ['Bob question', 'reply to Bob question'], 'bob messages');
    fails(await rpc('anon', 'export_my_data'), 'anon export', /permission denied/);
  });

  /* ------------------------------------------------------------ clear + delete */
  await test('retention', 'clear_ai_history removes only the caller\'s messages (proposals and usage stay)', async () => {
    const n = ok(await rpc('alice', 'clear_ai_history'), 'clear');
    assert(n >= 4, `deleted ${n}`);
    eq((ok(await rpc('alice', 'list_ai_messages', { p_limit: 50 }), 'after')).length, 0, 'alice empty');
    eq((ok(await rpc('bob', 'list_ai_messages', { p_limit: 50 }), 'bob')).length, 2, 'bob intact');
    assert((ok(await rpc('alice', 'list_ai_proposals'), 'proposals')).length > 0, 'proposals kept');
  });
  await test('retention', 'deleting the auth user removes their AI settings, messages, usage and proposals', async () => {
    ok(await rpc('eve', 'save_ai_settings', { p: J({ enabled: true, acceptConsent: true }) }), 'eve enable');
    ok(await rpc('service', 'ai_record_exchange', withUser(U.eve, exchange(randomUUID(), 'eve', { baseProgramId: null, baseVersion: null, program: proposedProgram, changeSummary: [], target: 'apply', validationErrors: [] }))), 'eve exchange');
    await admin.query(`delete from auth.users where id = $1`, [U.eve]);
    for (const [t, col] of [['ai_settings', 'user_id'], ['ai_messages', 'user_id'], ['ai_usage', 'user_id'], ['program_proposals', 'client_id']]) {
      eq((await admin.query(`select count(*)::int n from public.${t} where ${col} = $1`, [U.eve])).rows[0].n, 0, t);
    }
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
console.log('\nAI coach database tests\n');
const aw = Math.max(...results.map((r) => r.area.length));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.area.padEnd(aw)}  ${r.name}${r.ok ? '' : `\n        → ${r.err}`}`);
console.log(`\n${fail === 0 ? 'ALL PASSED' : 'FAILURES'}: ${pass} passed, ${fail} failed, ${results.length} total`);
if (fail) exitCode = 1;
process.exit(exitCode);
