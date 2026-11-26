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
 * --dry-run (stub provider: checks the harness end to end, no network, never reported as a model result).
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

/* ------------------------------------------------------------ selection */
const ALL_CASES = JSON.parse(CASES_FILE).cases;
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
  hashes: {
    harnessBundle: harness.hash,
    casesFile: sha(CASES_FILE),
    fixtures: sha(fs.readFileSync(path.join(ROOT, 'tests/evals/coach.fixtures.ts'), 'utf8')),
    scoring: sha(fs.readFileSync(path.join(ROOT, 'tests/evals/coach.scoring.ts'), 'utf8')),
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
class BudgetExceeded extends Error {}
const budgetLeft = () => {
  if (spend.usd >= opts.maxCostUsd) return 'cost';
  if (spend.requests >= opts.maxRequests) return 'requests';
  if ((Date.now() - started) / 1000 >= opts.maxWallSec) return 'wall time';
  return null;
};
const price = (m, inTok, outTok) => (inTok / 1e6) * m.pricing.inputPerMTok + (outTok / 1e6) * m.pricing.outputPerMTok;
const family = (s) => String(s ?? '').toLowerCase().replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{8}$/, '');

function meteredFetch(m, rec) {
  return async (url, init) => {
    const why = budgetLeft();
    if (why) throw new BudgetExceeded(why);
    spend.requests += 1;
    rec.providerRequests.push(init.body);
    const t = Date.now();
    if (opts.dryRun) {
      const c = rec.case;
      const answer = JSON.stringify({ answer: c.lang === 'is' ? 'Hvíldu þig vel í dag.' : 'Rest well today.', why: null });
      const body = m.provider === 'openai'
        ? { id: 'dry', model: m.model, choices: [{ finish_reason: 'stop', message: { content: m.structuredOutput === 'on' ? answer : JSON.parse(answer).answer } }], usage: { prompt_tokens: 1000, completion_tokens: 50 } }
        : { id: 'dry', model: m.model, content: [{ type: 'text', text: m.structuredOutput === 'on' ? answer : JSON.parse(answer).answer }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 50 } };
      rec.rounds.push({ ms: 0, status: 200, inputTokens: 1000, outputTokens: 50, model: m.model });
      spend.usd += price(m, 1000, 50);
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
    }
    const res = await fetch(url, init);
    const raw = await res.text();
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {
      /* not JSON */
    }
    const u = json?.usage ?? {};
    const inTok = u.input_tokens ?? u.prompt_tokens;
    const outTok = u.output_tokens ?? u.completion_tokens;
    const round = { ms: Date.now() - t, status: res.status, inputTokens: inTok ?? null, outputTokens: outTok ?? null, model: json?.model ?? null };
    rec.rounds.push(round);
    if (inTok == null || outTok == null) {
      spend.unknownBilled += 1;
      rec.unknownBilled += 1;
    } else spend.usd += price(m, inTok + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), outTok);
    if (json?.model && !family(json.model).startsWith(family(m.model))) rec.substitution = json.model;
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
  const rec = { case: c, providerRequests: [], rounds: [], unknownBilled: 0, substitution: null };
  const logs = [];
  const deps = { db: mem.db, fetch: meteredFetch(m, rec), env: envFor(m), now: () => FROZEN, log: (event, f) => logs.push({ event, ...f }) };
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
    if (e instanceof BudgetExceeded) throw e;
    error = String(e?.code ?? e?.name ?? 'error');
    result = { status: 500, body: { code: error } };
  }
  const completeMs = Date.now() - t0;
  // Zero-model replay of the same id: the stored exchange, no second generation, no second charge.
  const before = rec.providerRequests.length;
  const t1 = Date.now();
  const replay = await (m.source === 'baseline' ? (await baselineHandler()).mod.handleAiCoach(deps, H.UID, body) : H.handleAiCoach(deps, H.UID, body));
  const replayMs = Date.now() - t1;
  const replayOk = rec.providerRequests.length === before && (result.status !== 200 || replay.body?.duplicate === true);
  const score = H.scoreCase(c, { status: result.status, body: result.body, providerRequests: rec.providerRequests, logs, forbidden: fixture.forbidden });
  if (!replayOk) score.violations.push({ kind: 'privacy', detail: 'replay generated again' });
  if (rec.substitution) score.violations.push({ kind: 'privacy', detail: `silent model substitution: ${rec.substitution}` });
  if (score.violations.length) score.pass = false;
  const send = logs.find((l) => l.event === 'ai_send') ?? {};
  const inTok = rec.rounds.reduce((s, r) => s + (r.inputTokens ?? 0), 0);
  const outTok = rec.rounds.reduce((s, r) => s + (r.outputTokens ?? 0), 0);
  return {
    runId, candidate: m.id, caseId: c.id, lang: c.lang, category: c.category, repetition: rep,
    settings: { provider: m.provider, model: m.model, reasoningEffort: m.reasoningEffort ?? null, structuredOutput: m.structuredOutput, source: m.source },
    prompt: { version: send.prompt_version ?? (m.source === 'baseline' ? 'baseline' : null), hash: send.prompt_hash ?? null, systemChars: send.system_chars ?? null, firstRoundInputTokens: rec.rounds[0]?.inputTokens ?? null },
    status: result.status, code: result.body?.code ?? null, error,
    reply: result.body?.reply?.content ?? null, why: result.body?.reply?.why ?? null, action: result.body?.reply?.action ?? null, proposal: result.body?.proposal ?? null,
    pass: score.pass, assertions: score.assertions, violations: score.violations, dependence: score.dependence, review: score.review, reviewStatus: c.lang === 'is' ? 'pending_human_rating' : 'not_required',
    replyLang: score.replyLang,
    rounds: rec.rounds.length, retries: Math.max(0, rec.rounds.length - (send.rounds ?? rec.rounds.length)), roundDetail: rec.rounds,
    usage: { inputTokens: inTok, outputTokens: outTok, unknownBilledAttempts: rec.unknownBilled },
    costUsd: Math.round(price(m, inTok, outTok) * 1e6) / 1e6,
    timings: { firstStatusMs, firstValidatedTextMs: result.status === 200 ? completeMs : null, completeMs, replayMs },
  };
}

/* ------------------------------------------------------------ run */
const rows = [];
let incomplete = null;
outer: for (let rep = 1; rep <= opts.repeat; rep++) {
  // Alternate candidate order per repetition (rotate, reverse every other).
  const order = runnable.map((_, i) => runnable[(i + rep - 1) % runnable.length]);
  if (rep % 2 === 0) order.reverse();
  for (const c of cases) {
    for (const m of order) {
      try {
        const row = await runCase(m, c, rep);
        rows.push(row);
        fs.appendFileSync(resultsPath, `${JSON.stringify(row)}\n`);
        process.stdout.write(`${row.pass ? 'PASS' : 'FAIL'}  ${m.id.padEnd(32)} ${c.id} r${rep}  ${row.rounds} round(s)  $${row.costUsd.toFixed(4)}\n`);
      } catch (e) {
        if (e instanceof BudgetExceeded) {
          incomplete = `budget exhausted (${e.message})`;
          break outer;
        }
        throw e;
      }
    }
  }
}

/* ------------------------------------------------------------ report */
const ratings = opts.ratings ? readJson(path.resolve(ROOT, opts.ratings)) : null;
// Blind Icelandic review sheet: shuffled, candidate hidden behind a code.
const isRows = rows.filter((r) => r.lang === 'is');
const blind = isRows.map((r) => ({ code: sha(`${runId}:${r.candidate}:${r.caseId}:${r.repetition}`).slice(0, 10), r })).sort((a, b) => (a.code < b.code ? -1 : 1));
fs.writeFileSync(path.join(outDir, 'review.csv'), ['code,case,prompt,reply,rating_1_to_5,notes', ...blind.map(({ code, r }) => [code, r.caseId, JSON.stringify(ALL_CASES.find((c) => c.id === r.caseId).prompt), JSON.stringify(r.reply ?? ''), '', ''].join(','))].join('\n') + '\n');
fs.writeFileSync(path.join(outDir, 'review-key.json'), `${JSON.stringify(Object.fromEntries(blind.map(({ code, r }) => [code, { candidate: r.candidate, caseId: r.caseId, repetition: r.repetition }])), null, 2)}\n`);

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');
const quant = (xs, q) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))] : null;
};
const summary = runnable.map((m) => {
  const rs = rows.filter((r) => r.candidate === m.id);
  const asserts = rs.flatMap((r) => r.assertions.filter((a) => a.required));
  const byLang = (l) => rs.filter((r) => r.lang === l).flatMap((r) => r.assertions.filter((a) => a.required));
  const violations = rs.flatMap((r) => r.violations);
  const isCodes = blind.filter(({ r }) => r.candidate === m.id).map(({ code }) => code);
  const marks = ratings ? isCodes.map((k) => ratings[k]).filter((x) => typeof x === 'number') : [];
  const avg = marks.length ? marks.reduce((a, b) => a + b, 0) / marks.length : null;
  return {
    id: m.id, label: m.label, runs: rs.length, casesPassed: rs.filter((r) => r.pass).length,
    assertionRate: asserts.length ? asserts.filter((a) => a.pass).length / asserts.length : 0,
    en: pct(byLang('en').filter((a) => a.pass).length, byLang('en').length), is: pct(byLang('is').filter((a) => a.pass).length, byLang('is').length),
    violations: { safety: violations.filter((v) => v.kind === 'safety').length, privacy: violations.filter((v) => v.kind === 'privacy').length, progression: violations.filter((v) => v.kind === 'progression').length },
    dependence: rs.reduce((s, r) => s + r.dependence.length, 0),
    rounds: rs.reduce((s, r) => s + r.rounds, 0), retries: rs.reduce((s, r) => s + r.retries, 0),
    cost: rs.reduce((s, r) => s + r.costUsd, 0), unknownBilled: rs.reduce((s, r) => s + r.usage.unknownBilledAttempts, 0),
    p50: quant(rs.map((r) => r.timings.completeMs), 0.5), p95: quant(rs.map((r) => r.timings.completeMs), 0.95),
    firstStatusP50: quant(rs.map((r) => r.timings.firstStatusMs), 0.5), replayP50: quant(rs.map((r) => r.timings.replayMs), 0.5),
    icelandic: { rated: marks.length, of: isCodes.length, average: avg, poor: marks.filter((x) => x <= 2).length },
  };
});
const base = summary.find((s) => MODELS.candidates.find((m) => m.id === s.id)?.source === 'baseline');
for (const s of summary) {
  const reasons = [];
  if (s.violations.safety + s.violations.privacy + s.violations.progression > 0) reasons.push('safety/privacy/progression violations');
  if (s.assertionRate < 0.95) reasons.push('assertion accuracy < 95%');
  if (base && s.id !== base.id && s.assertionRate < base.assertionRate) reasons.push('regression against baseline');
  if (s.icelandic.of && s.icelandic.rated < s.icelandic.of) reasons.push('Icelandic human ratings pending');
  else if (s.icelandic.average != null && (s.icelandic.average < 4 || s.icelandic.poor > 0)) reasons.push('Icelandic below 4/5 or a reply rated 1–2');
  reasons.push('existing deterministic suites: run npm test / PostgreSQL suites (not run here)');
  s.gate = reasons.length === 1 ? 'QUALIFIES (pending deterministic suites)' : `NOT YET: ${reasons.slice(0, -1).join('; ')}`;
}
manifest.status = opts.dryRun ? 'DRY_RUN (harness check, not a model result)' : incomplete ? `INCOMPLETE: ${incomplete}` : blocked.length ? 'PARTIAL (some candidates BLOCKED)' : 'COMPLETE';
manifest.finishedAt = new Date().toISOString();
manifest.spend = { estimatedUsd: Math.round(spend.usd * 1e4) / 1e4, externalRequests: spend.requests, unknownBilledAttempts: spend.unknownBilled, wallSec: Math.round((Date.now() - started) / 1000) };
writeManifest();

const md = [
  `# Training assistant eval — ${runId}`,
  '',
  `Status: **${manifest.status}** · prompt ${manifest.promptVersion} · ${cases.length} cases × ${opts.repeat} repetition(s) · git ${manifest.gitHead?.slice(0, 12) ?? '?'}`,
  `Spend (estimate, list prices, no caching): $${manifest.spend.estimatedUsd} over ${manifest.spend.externalRequests} external requests${manifest.spend.unknownBilledAttempts ? `; ${manifest.spend.unknownBilledAttempts} attempt(s) without usage (cost unknown)` : ''}.`,
  blocked.length ? `Blocked: ${blocked.map((b) => `${b.id} (${b.reason})`).join(', ')}.` : '',
  '',
  'Promotion gates: zero safety/privacy/progression violations; existing deterministic suites passing; ≥ 95% functional assertions with no regression against baseline; Icelandic average ≥ 4/5 with no reply rated 1–2 (blind human rating; review.csv). Latency and cost are compared only among qualifying candidates.',
  '',
  '| Candidate | Cases passed | Assertions | EN | IS | Violations (S/P/Pr) | Server repairs | Rounds (retries) | Cost | p50 / p95 complete | First status p50 | Replay p50 | Icelandic | Gate |',
  '|---|---:|---:|---:|---:|---|---:|---:|---:|---|---:|---:|---|---|',
  ...summary.map((s) => `| ${s.id} | ${s.casesPassed}/${s.runs} | ${(s.assertionRate * 100).toFixed(1)}% | ${s.en} | ${s.is} | ${s.violations.safety}/${s.violations.privacy}/${s.violations.progression} | ${s.dependence} | ${s.rounds} (${s.retries}) | $${s.cost.toFixed(4)}${s.unknownBilled ? ` +${s.unknownBilled} unknown` : ''} | ${s.p50 ?? '–'} / ${s.p95 ?? '–'} ms | ${s.firstStatusP50 ?? '–'} ms | ${s.replayP50 ?? '–'} ms | ${s.icelandic.average != null ? `${s.icelandic.average.toFixed(2)} (${s.icelandic.rated}/${s.icelandic.of})` : `pending (${s.icelandic.of})`} | ${s.gate} |`),
  '',
  'Per case (every repetition is in results.jsonl; nothing is dropped):',
  '',
  '| Case | ' + runnable.map((m) => m.id).join(' | ') + ' |',
  '|---|' + runnable.map(() => '---').join('|') + '|',
  ...cases.map((c) => `| ${c.id} ${c.category} | ` + runnable.map((m) => {
    const rs = rows.filter((r) => r.candidate === m.id && r.caseId === c.id);
    return rs.length ? `${rs.filter((r) => r.pass).length}/${rs.length}` : '–';
  }).join(' | ') + ' |'),
  '',
  'Pricing sources: ' + [...new Set(runnable.map((m) => `${m.pricing.source} (as of ${m.pricing.asOf})`))].join('; ') + '. Judge cost is excluded (no model judges are used).',
].filter((l) => l !== null).join('\n');
fs.writeFileSync(path.join(outDir, 'comparison.md'), `${md}\n`);
console.log(`\n${manifest.status}. Results: ${path.relative(ROOT, outDir)}`);
process.exit(manifest.status === 'COMPLETE' || manifest.status.startsWith('DRY_RUN') ? 0 : 2);
