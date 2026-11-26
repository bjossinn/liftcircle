#!/usr/bin/env node
/**
 * Training assistant eval + model comparison (roadmap item 10). OPT-IN, LIVE, costs money.
 *
 *   node tests/live/coach-eval.mjs \
 *     --models tests/evals/coach.models.json --cases tests/evals/coach.cases.json \
 *     --repeat 3 --max-cost-usd 10 --out artifacts/coach-eval
 *
 * Options: --candidates id,id (subset) · --only EN01,IS07 (subset of cases) · --max-requests N (external requests,
 * default 3000) · --max-wall-sec N (default 3600) · --ratings file.json (blind Icelandic ratings, see review.csv) ·
 * --dry-run (stub provider: checks the harness end to end, no network, never reported as a model result) ·
 * --report <run dir> (report only: re-read that run's manifest, results.jsonl and blind codes, attach the reviews from
 * --ratings, rewrite comparison.md; makes NO model calls).
 *
 * Ratings file (one entry per blind code from review.csv): {"<code>": {"safety": "pass"|"fail", "icelandic": 1-5}}.
 * A safety review is required for EVERY result, English and Icelandic; Icelandic results also need a 1–5 rating.
 *
 * What it runs: the REAL request handler (supabase/functions/_shared/ai/coach.ts, bundled in memory), the production
 * exercise/recipe/ingredient catalogs, tools, validators and fallbacks, on fresh synthetic state per case × candidate ×
 * repetition (tests/evals/coach.fixtures.ts; the reservation-aware in-memory database tests/evals/memoryDb.ts). Domain
 * time is frozen at 2026-11-26T12:00:00Z (Atlantic/Reykjavik, Monday weeks); latency and deadline clocks are real.
 * "baseline" candidates run the handler from the pre-item-10 commit (models file: baselineRef) via `git archive`.
 *
 * Every candidate is explicit (provider, model, reasoning, output mode, matching synthetic consent). Candidate order
 * alternates per repetition; every repetition is kept. All model rounds and retries are counted and costed (failed
 * ones too). Missing credentials or an exhausted budget is BLOCKED / INCOMPLETE, never a pass (exit code 2).
 *
 * Writes <out>/<run-id>/manifest.json, results.jsonl (append-only, one line per case × candidate × repetition),
 * comparison.md and review.csv (blind Icelandic rating sheet). Synthetic data only.
 */
import { build } from 'esbuild';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/* ------------------------------------------------------------ args */
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);
const opts = {
  models: path.resolve(ROOT, arg('models', 'tests/evals/coach.models.json')),
  cases: path.resolve(ROOT, arg('cases', 'tests/evals/coach.cases.json')),
  repeat: Math.max(1, Number(arg('repeat', '1')) || 1),
  maxCostUsd: Number(arg('max-cost-usd', '10')),
  maxRequests: Number(arg('max-requests', '3000')),
  maxWallSec: Number(arg('max-wall-sec', '3600')),
  out: path.resolve(ROOT, arg('out', 'artifacts/coach-eval')),
  only: arg('only', '') ? arg('only', '').split(',') : null,
  candidates: arg('candidates', '') ? arg('candidates', '').split(',') : null,
  ratings: arg('ratings', null),
  dryRun: flag('dry-run'),
  report: arg('report', null),
};

const sha = (s) => createHash('sha256').update(s).digest('hex');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const MODELS = readJson(opts.models);
const CASES_FILE = fs.readFileSync(opts.cases, 'utf8');

/* ------------------------------------------------------------ bundles */
const aliasPlugin = (srcRoot) => ({
  name: 'alias',
  setup(b) {
    b.onResolve({ filter: /^@\// }, (a) => {
      const base = path.join(srcRoot, a.path.slice(2));
      for (const ext of ['', '.ts', '.tsx', '/index.ts']) if (fs.existsSync(base + ext) && fs.statSync(base + ext).isFile()) return { path: base + ext };
      return { path: base };
    });
  },
});
async function bundle(contents, resolveDir) {
  const out = await build({ stdin: { contents, resolveDir, loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent', plugins: [aliasPlugin(path.join(ROOT, 'src'))] });
  const text = out.outputFiles[0].text;
  return { mod: await import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`), hash: sha(text) };
}
const harness = await bundle(
  `export * from './tests/evals/coach.fixtures.ts'; export * from './tests/evals/coach.scoring.ts';
   export { startAiCoach, handleAiCoach } from './supabase/functions/_shared/ai/coach.ts';
   export * from './tests/evals/coach.report.ts';
   export { PROMPT_VERSION } from './supabase/functions/_shared/ai/prompts/index.ts';`,
  ROOT,
);
const H = harness.mod;
let baseline = null;
async function baselineHandler() {
  if (baseline) return baseline;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-baseline-'));
  const tar = execFileSync('git', ['-C', ROOT, 'archive', MODELS.baselineRef, 'supabase/functions'], { maxBuffer: 64 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', dir], { input: tar });
  baseline = await bundle(`export { handleAiCoach } from './supabase/functions/_shared/ai/coach.ts';`, dir);
  return baseline;
}

/* ------------------------------------------------------------ report (shared by the live run and --report) */
const ALL_CASES = JSON.parse(CASES_FILE).cases;
const PROMPTS = Object.fromEntries(ALL_CASES.map((c) => [c.id, c.prompt]));
const requiredRepetitions = Number(MODELS.requiredRepetitions ?? 3);

async function writeReport(dir, manifest, rows) {
  const ratings = opts.ratings ? H.normalizeReviews(readJson(path.resolve(ROOT, opts.ratings))) : {};
  const sheet = await H.reviewSheet(manifest.runId, rows, PROMPTS);
  fs.writeFileSync(path.join(dir, 'review.csv'), sheet.csv);
  const keyPath = path.join(dir, 'review-key.json');
  // The blind key is written once and then reused: codes stay stable, so reviews attach to the original run.
  const key = fs.existsSync(keyPath) ? { ...sheet.key, ...readJson(keyPath) } : sheet.key;
  fs.writeFileSync(keyPath, `${JSON.stringify(key, null, 2)}\n`);
  const { markdown, summary } = H.renderComparison({
    runId: manifest.runId, status: manifest.status, rows, candidates: manifest.candidates.filter((c) => !manifest.blocked?.some((b) => b.id === c.id)),
    allCaseIds: ALL_CASES.map((c) => c.id), requiredRepetitions, reviews: ratings, key,
    spend: manifest.spend, promptVersion: manifest.promptVersion, gitHead: manifest.gitHead, blocked: manifest.blocked,
  });
  fs.writeFileSync(path.join(dir, 'comparison.md'), markdown);
  manifest.qualification = summary.map((s) => ({ id: s.id, qualifies: s.qualifies, gate: s.gate }));
  manifest.reviews = { file: opts.ratings ? path.relative(ROOT, path.resolve(ROOT, opts.ratings)) : null, entries: Object.keys(ratings).length, reportedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return summary;
}

if (opts.report) {
  // Report-only: no model calls, no provider keys needed.
  const dir = path.resolve(ROOT, opts.report);
  const manifest = readJson(path.join(dir, 'manifest.json'));
  const rows = fs.readFileSync(path.join(dir, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const summary = await writeReport(dir, manifest, rows);
  for (const s of summary) console.log(`${s.id.padEnd(32)} ${s.gate}`);
  console.log(`\nReport rewritten (no model calls): ${path.relative(ROOT, dir)}`);
  process.exit(0);
}

/* ------------------------------------------------------------ selection */
const cases = ALL_CASES.filter((c) => !opts.only || opts.only.includes(c.id));
const candidates = MODELS.candidates.filter((m) => !opts.candidates || opts.candidates.includes(m.id));
const keyFor = (m) => (m.provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY);
const runnable = candidates.filter((m) => opts.dryRun || keyFor(m));
const blocked = candidates.filter((m) => !runnable.includes(m)).map((m) => ({ id: m.id, reason: `missing ${m.provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'}` }));

const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}${opts.dryRun ? '-dry' : ''}`;
const outDir = path.join(opts.out, runId);
fs.mkdirSync(outDir, { recursive: true });
const resultsPath = path.join(outDir, 'results.jsonl');
const manifest = {
  runId,
  status: 'RUNNING',
  dryRun: opts.dryRun,
  startedAt: new Date().toISOString(),
  options: { ...opts, models: path.relative(ROOT, opts.models), cases: path.relative(ROOT, opts.cases), out: path.relative(ROOT, opts.out) },
  scope: {
    cases: cases.map((c) => c.id), fullCorpus: cases.length === ALL_CASES.length, repetitions: opts.repeat, requiredRepetitions,
    // A subset, fewer repetitions or a missing baseline is diagnostic only: it can never qualify a candidate.
    diagnosticOnly: cases.length !== ALL_CASES.length || opts.repeat < requiredRepetitions || !runnable.some((m) => m.source === 'baseline'),
  },
  hashes: {
    harnessBundle: harness.hash,
    casesFile: sha(CASES_FILE),
    fixtures: sha(fs.readFileSync(path.join(ROOT, 'tests/evals/coach.fixtures.ts'), 'utf8')),
    scoring: sha(fs.readFileSync(path.join(ROOT, 'tests/evals/coach.scoring.ts'), 'utf8')),
    report: sha(fs.readFileSync(path.join(ROOT, 'tests/evals/coach.report.ts'), 'utf8')),
    modelsFile: sha(fs.readFileSync(opts.models, 'utf8')),
  },
  gitHead: (() => {
    try {
      return execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  })(),
  promptVersion: H.PROMPT_VERSION,
  candidates: candidates.map((m) => ({ ...m })),
  blocked,
  budgets: { maxCostUsd: opts.maxCostUsd, maxRequests: opts.maxRequests, maxWallSec: opts.maxWallSec },
  catalogControls: Object.fromEntries(Object.entries(H.catalogControls()).map(([k, v]) => [k, { safe: v.safe.length, dangerous: v.dangerous.length }])),
  clock: JSON.parse(CASES_FILE).clock,
};
const writeManifest = () => fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
writeManifest();

if (!runnable.length) {
  manifest.status = 'BLOCKED';
  writeManifest();
  console.log(`BLOCKED: no runnable candidates (${blocked.map((b) => `${b.id}: ${b.reason}`).join('; ')}). Results: ${path.relative(ROOT, outDir)}`);
  process.exit(2);
}

/* ------------------------------------------------------------ budgets & transport */
const spend = { usd: 0, requests: 0, unknownBilled: 0 };
const started = Date.now();
/** Sticky (review P2-7): once a budget is exhausted, no further request, retry or case starts. */
let exhausted = null;
class BudgetExceeded extends Error {}
const checkBudget = () => {
  if (exhausted) return exhausted;
  if (spend.usd >= opts.maxCostUsd) exhausted = 'cost';
  else if (spend.requests >= opts.maxRequests) exhausted = 'requests';
  else if ((Date.now() - started) / 1000 >= opts.maxWallSec) exhausted = 'wall time';
  return exhausted;
};
const price = (m, inTok, outTok) => (inTok / 1e6) * m.pricing.inputPerMTok + (outTok / 1e6) * m.pricing.outputPerMTok;

/**
 * Every DISPATCHED attempt is recorded (review P2-4): its outcome, latency and usage when known. An attempt that was
 * sent but never produced known usage (aborted, timed out, network error, unreadable body) is "unknown billed": it may
 * have cost money, so it is never reported as zero.
 */
function meteredFetch(m, rec) {
  return async (url, init) => {
    if (checkBudget()) throw new BudgetExceeded(exhausted);
    spend.requests += 1;
    rec.providerRequests.push(init.body);
    const t = Date.now();
    const attempt = { ms: null, status: null, outcome: 'dispatched', inputTokens: null, outputTokens: null, model: null, unknownUsage: true };
    rec.attempts.push(attempt);
    const settle = (o) => Object.assign(attempt, { ms: Date.now() - t }, o);
    if (opts.dryRun) {
      const c = rec.case;
      const answer = JSON.stringify({ answer: c.lang === 'is' ? 'Hvíldu þig vel í dag.' : 'Rest well today.', why: null });
      const text = m.structuredOutput === 'on' ? answer : JSON.parse(answer).answer;
      const body = m.provider === 'openai'
        ? { id: 'dry', model: m.model, choices: [{ finish_reason: 'stop', message: { content: text } }], usage: { prompt_tokens: 1000, completion_tokens: 50 } }
        : { id: 'dry', model: m.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 50 } };
      settle({ status: 200, outcome: 'completed', inputTokens: 1000, outputTokens: 50, model: m.model, unknownUsage: false });
      spend.usd += price(m, 1000, 50);
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
    }
    let res;
    let raw;
    try {
      res = await fetch(url, init);
      raw = await res.text();
    } catch (e) {
      settle({ outcome: e?.name === 'AbortError' ? 'aborted' : 'network_error' });
      spend.unknownBilled += 1;
      rec.unknownBilled += 1;
      throw e;
    }
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {
      /* not JSON */
    }
    const u = json?.usage ?? {};
    const inTok = u.input_tokens ?? u.prompt_tokens;
    const outTok = u.output_tokens ?? u.completion_tokens;
    const known = inTok != null && outTok != null;
    settle({ status: res.status, outcome: res.ok ? (json ? 'completed' : 'unreadable') : 'http_error', inputTokens: inTok ?? null, outputTokens: outTok ?? null, model: json?.model ?? null, unknownUsage: res.ok && !known });
    if (known) spend.usd += price(m, inTok + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), outTok);
    else if (res.ok) {
      spend.unknownBilled += 1;
      rec.unknownBilled += 1;
    }
    if (json?.model && !H.sameModel(m.model, json.model, m.aliases ?? [])) rec.substitution = json.model;
    return { ok: res.ok, status: res.status, headers: res.headers, json: async () => json, text: async () => raw };
  };
}

/* ------------------------------------------------------------ one case */
const FROZEN = new Date(JSON.parse(CASES_FILE).clock.now);
function envFor(m) {
  const e = { AI_PROVIDER: m.provider, AI_STRUCTURED_OUTPUT: m.structuredOutput, AI_CANCEL_POLL_MS: '10000' };
  if (m.provider === 'openai') Object.assign(e, { OPENAI_API_KEY: opts.dryRun ? 'dry' : process.env.OPENAI_API_KEY, OPENAI_MODEL: m.model, OPENAI_REASONING_EFFORT: m.reasoningEffort ?? 'off' });
  else Object.assign(e, { ANTHROPIC_API_KEY: opts.dryRun ? 'dry' : process.env.ANTHROPIC_API_KEY, ANTHROPIC_MODEL: m.model });
  return (k) => e[k];
}
async function runCase(m, c, rep) {
  const fixture = H.buildFixture(c, m.provider);
  const mem = H.freshDb(fixture);
  const rec = { case: c, providerRequests: [], attempts: [], unknownBilled: 0, substitution: null };
  const logs = [];
  // Backoff waits end at once after a budget is exhausted, so no retry waits (and none is dispatched: meteredFetch refuses).
  const sleep = (ms) => (exhausted ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)));
  const deps = { db: mem.db, fetch: meteredFetch(m, rec), env: envFor(m), now: () => FROZEN, sleep, log: (event, f) => logs.push({ event, ...f }) };
  const id = randomUUID();
  const body = { action: 'send', id, text: c.prompt, mode: 'chat', ...fixture.body };
  const t0 = Date.now();
  let firstStatusMs = null;
  let result;
  let error = null;
  try {
    if (m.source === 'baseline') result = await (await baselineHandler()).mod.handleAiCoach(deps, H.UID, body);
    else {
      const s = await H.startAiCoach(deps, H.UID, body);
      result = s.kind === 'done' ? s.result : await s.run({ onPhase: () => (firstStatusMs ??= Date.now() - t0) });
    }
  } catch (e) {
    error = String(e?.code ?? e?.name ?? 'error');
    result = { status: 500, body: { code: error } };
  }
  const completeMs = Date.now() - t0;
  // Zero-model replay of the same id: the stored exchange, no second generation, no second charge.
  let replay = null;
  let replayMs = null;
  const before = rec.providerRequests.length;
  if (!exhausted) {
    const t1 = Date.now();
    replay = await (m.source === 'baseline' ? (await baselineHandler()).mod.handleAiCoach(deps, H.UID, body) : H.handleAiCoach(deps, H.UID, body));
    replayMs = Date.now() - t1;
  }
  const replayOk = !replay || (rec.providerRequests.length === before && (result.status !== 200 || replay.body?.duplicate === true));
  const score = H.scoreCase(c, { status: result.status, body: result.body, providerRequests: rec.providerRequests, logs, forbidden: fixture.forbidden });
  if (!replayOk) score.violations.push({ kind: 'privacy', detail: 'replay generated again' });
  if (rec.substitution) score.violations.push({ kind: 'privacy', detail: `model substitution: requested ${m.model}, served ${rec.substitution}` });
  if (score.violations.length) score.pass = false;
  const send = logs.find((l) => l.event === 'ai_send') ?? {};
  const inTok = rec.attempts.reduce((s, r) => s + (r.inputTokens ?? 0), 0);
  const outTok = rec.attempts.reduce((s, r) => s + (r.outputTokens ?? 0), 0);
  const completed = rec.attempts.filter((a) => a.outcome === 'completed').length;
  return {
    runId, candidate: m.id, caseId: c.id, lang: c.lang, category: c.category, repetition: rep,
    settings: { provider: m.provider, model: m.model, aliases: m.aliases ?? [], reasoningEffort: m.reasoningEffort ?? null, structuredOutput: m.structuredOutput, source: m.source },
    prompt: { version: send.prompt_version ?? (m.source === 'baseline' ? 'baseline' : null), hash: send.prompt_hash ?? null, systemChars: send.system_chars ?? null, firstRoundInputTokens: rec.attempts.find((a) => a.outcome === 'completed')?.inputTokens ?? null },
    status: result.status, code: result.body?.code ?? null, error,
    reply: result.body?.reply?.content ?? null, why: result.body?.reply?.why ?? null, action: result.body?.reply?.action ?? null, proposal: result.body?.proposal ?? null,
    pass: score.pass, safetyReview: 'pending', assertions: score.assertions, violations: score.violations, dependence: score.dependence, review: score.review,
    reviewStatus: c.lang === 'is' ? 'pending_safety_review_and_icelandic_rating' : 'pending_safety_review',
    replyLang: score.replyLang,
    rounds: completed, attempts: rec.attempts.length, retries: Math.max(0, rec.attempts.length - completed), attemptDetail: rec.attempts,
    usage: { inputTokens: inTok, outputTokens: outTok, unknownBilledAttempts: rec.unknownBilled },
    costUsd: Math.round(price(m, inTok, outTok) * 1e6) / 1e6,
    timings: { firstStatusMs, firstValidatedTextMs: result.status === 200 ? completeMs : null, completeMs, replayMs },
    ...(exhausted ? { budgetInterrupted: true } : {}),
  };
}

/* ------------------------------------------------------------ run */
const rows = [];
outer: for (let rep = 1; rep <= opts.repeat; rep++) {
  // Alternate candidate order per repetition (rotate, reverse every other).
  const order = runnable.map((_, i) => runnable[(i + rep - 1) % runnable.length]);
  if (rep % 2 === 0) order.reverse();
  for (const c of cases) {
    for (const m of order) {
      if (checkBudget()) break outer;
      const row = await runCase(m, c, rep);
      rows.push(row);
      fs.appendFileSync(resultsPath, `${JSON.stringify(row)}\n`);
      process.stdout.write(`${row.budgetInterrupted ? 'STOP' : row.pass ? 'PASS' : 'FAIL'}  ${m.id.padEnd(32)} ${c.id} r${rep}  ${row.attempts} attempt(s)  $${row.costUsd.toFixed(4)}${row.usage.unknownBilledAttempts ? ` +${row.usage.unknownBilledAttempts} unknown` : ''}\n`);
      if (exhausted) break outer;
    }
  }
}

manifest.status = exhausted
  ? `INCOMPLETE: budget exhausted (${exhausted})${opts.dryRun ? ' — dry run' : ''}`
  : opts.dryRun
    ? 'DRY_RUN (harness check, not a model result)'
    : blocked.length
      ? 'PARTIAL (some candidates BLOCKED)'
      : manifest.scope.diagnosticOnly
        ? 'COMPLETE (diagnostic scope)'
        : 'COMPLETE';
manifest.finishedAt = new Date().toISOString();
manifest.spend = { estimatedUsd: Math.round(spend.usd * 1e4) / 1e4, externalRequests: spend.requests, unknownBilledAttempts: spend.unknownBilled, wallSec: Math.round((Date.now() - started) / 1000) };
writeManifest();
await writeReport(outDir, manifest, rows);
console.log(`\n${manifest.status}. Results: ${path.relative(ROOT, outDir)}`);
console.log(`Next: fill in review.csv (safety for every row; Icelandic 1–5), save as {code: {safety, icelandic}} JSON, then: node tests/live/coach-eval.mjs --report ${path.relative(ROOT, outDir)} --ratings <file>`);
process.exit(manifest.status === 'COMPLETE' || manifest.status.startsWith('DRY_RUN') ? 0 : 2);
