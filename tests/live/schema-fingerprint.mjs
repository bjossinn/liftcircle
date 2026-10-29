#!/usr/bin/env node
/**
 * Local half of the deployed-schema parity check. Builds a throwaway PostgreSQL 16 cluster with the Supabase
 * stubs, applies supabase/migrations (optionally only up to a cutoff), and prints the fingerprint from
 * tests/live/schema-fingerprint.sql. Run the same SQL in the live project's SQL editor and compare rows.
 *   node tests/live/schema-fingerprint.mjs [--upto 20261029000004] [--then deploy/x.sql] [--detail fn|policy|table|grant|bucket]
 * Env: PG_BIN (default /usr/lib/postgresql/16/bin), FP_PG_PORT (default 55529).
 */
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = process.env.PG_BIN || '/usr/lib/postgresql/16/bin';
const PORT = Number(process.env.FP_PG_PORT || 55529);
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const upto = arg('--upto');
const detail = arg('--detail');
const then = arg('--then'); // extra SQL file applied after the migrations (e.g. deploy/…_migrations.sql)
const isRoot = process.getuid?.() === 0;
const sh = (cmd, args, allowFail = false) => {
  const full = isRoot ? ['runuser', ['-u', 'postgres', '--', cmd, ...args]] : [cmd, args];
  const r = spawnSync(full[0], full[1], { encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd}: ${r.stderr || r.stdout}`);
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-fp-'));
if (isRoot) { spawnSync('chown', ['-R', 'postgres', tmp]); fs.chmodSync(tmp, 0o755); }
const data = path.join(tmp, 'data');
try {
  sh(path.join(BIN, 'initdb'), ['-D', data, '-U', 'supabase_admin', '-A', 'trust', '-E', 'UTF8', '--locale=C', '--no-sync']);
  sh(path.join(BIN, 'pg_ctl'), ['-D', data, '-l', path.join(tmp, 'log'), '-w', '-t', '30', 'start', '-o', `-p ${PORT} -k ${tmp} -c listen_addresses=localhost -c fsync=off`]);
  const admin = new pg.Client({ host: 'localhost', port: PORT, user: 'supabase_admin', database: 'postgres' });
  await admin.connect();
  await admin.query(fs.readFileSync(path.join(ROOT, 'tests/rls/supabase-stub.sql'), 'utf8'));
  // The live project has Supabase's migration-history table; the local stub doesn't.
  await admin.query(`create schema if not exists supabase_migrations;
    create table if not exists supabase_migrations.schema_migrations (version text primary key, name text, statements text[]);
    grant usage on schema supabase_migrations to postgres; grant all on supabase_migrations.schema_migrations to postgres;`);
  const app = new pg.Client({ host: 'localhost', port: PORT, user: 'postgres', database: 'postgres' });
  await app.connect();
  const dir = path.join(ROOT, 'supabase/migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if (upto && f.slice(0, upto.length) > upto) continue;
    await app.query('begin'); await app.query(fs.readFileSync(path.join(dir, f), 'utf8')); await app.query('commit');
  }
  if (then) await app.query(fs.readFileSync(path.resolve(then), 'utf8'));
  const sql = fs.readFileSync(path.join(ROOT, 'tests/live/schema-fingerprint.sql'), 'utf8');
  if (detail) {
    const inner = sql.replace(/select kind, count\(\*\)[\s\S]*$/, `select k, v from items where kind = '${detail}' order by k;`);
    for (const r of (await admin.query(inner)).rows) console.log(`${r.k}=${r.v}`);
  } else {
    for (const r of (await admin.query(sql)).rows) console.log(`${r.kind}\t${r.n}\t${r.digest}`);
    const q = (await admin.query(`select count(*) n, md5(string_agg(schemaname||'.'||tablename||'.'||policyname||'='||coalesce(qual,'')||'|'||coalesce(with_check,''), ';' order by schemaname, tablename, policyname)) digest from pg_policies where schemaname in ('public','storage')`)).rows[0];
    console.log(`policy-expr\t${q.n}\t${q.digest}\t(deparsed text; may differ across PostgreSQL major versions)`);
  }
  await admin.end(); await app.end();
} finally {
  sh(path.join(BIN, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], true);
  fs.rmSync(tmp, { recursive: true, force: true });
}
