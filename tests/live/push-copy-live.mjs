#!/usr/bin/env node
/**
 * OPT-IN live evaluation of coach reminder copy (NOT mocked): node tests/live/push-copy-live.mjs
 *
 * Roadmap item 9: run this with the production provider settings before broadly enabling generated reminder wording
 * (PUSH_AI_COPY). It calls the real writeCopy() (supabase/functions/_shared/push/copy.ts, bundled in memory with
 * esbuild) for every reminder kind in English and Icelandic, LC_PUSH_COPY_RUNS times each (default 3), with a consenting
 * fixture (training + nutrition shared), and reports per kind/language: how often the model's text passed validation
 * (validateCopy: JSON shape, ≤ 140 code points, language, no guilt/targets/numbers), how often the fallback was used,
 * latency, and the generated texts for a human (native Icelandic) review. It never sends a notification and touches
 * no database.
 *
 * Env: OPENAI_API_KEY or ANTHROPIC_API_KEY (+ AI_PROVIDER, *_MODEL, PUSH_COPY_MODEL, PUSH_COPY_REASONING_EFFORT).
 * Without a key it prints BLOCKED and exits 0. Exit 1 when fewer than LC_PUSH_COPY_MIN_PASS (default 0.6) of the
 * calls for any kind/language produced valid generated copy.
 */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
  console.log('BLOCKED: set OPENAI_API_KEY or ANTHROPIC_API_KEY (and optionally AI_PROVIDER / *_MODEL) to run the live reminder copy evaluation.');
  process.exit(0);
}
const out = await build({ entryPoints: [path.join(ROOT, 'supabase/functions/_shared/push/copy.ts')], bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent' });
const { writeCopy, COACH_KINDS } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
const { resolveProvider } = await import(
  `data:text/javascript;base64,${Buffer.from((await build({ entryPoints: [path.join(ROOT, 'supabase/functions/_shared/ai/provider.ts')], bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent' })).outputFiles[0].text).toString('base64')}`
);

const env = (k) => (k === 'PUSH_AI_COPY' ? 'on' : process.env[k]); // evaluated before it is switched on
const provider = resolveProvider(env);
if (!provider) {
  console.log('BLOCKED: the configured provider has no key.');
  process.exit(0);
}
const ai = { enabled: true, paused: false, consentAt: new Date().toISOString(), consentVersion: `2026-10-29:${provider.provider}`, training: true, nutrition: true };
const runs = Math.max(1, Number(process.env.LC_PUSH_COPY_RUNS) || 3);
const minPass = Number(process.env.LC_PUSH_COPY_MIN_PASS) || 0.6;
let failed = false;
console.log(`Provider ${provider.provider}, model ${env('PUSH_COPY_MODEL') || provider.model}, ${runs} run(s) per kind and language\n`);
for (const kind of COACH_KINDS) {
  for (const language of ['en', 'is']) {
    let ai_ = 0;
    const texts = [];
    const times = [];
    const reasons = {};
    for (let i = 0; i < runs; i++) {
      const t0 = Date.now();
      const r = await writeCopy({ env, fetch }, kind, language, ai, 3000);
      times.push(Date.now() - t0);
      if (r.source === 'ai') {
        ai_++;
        texts.push(r.body);
      } else reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
    }
    const rate = ai_ / runs;
    if (rate < minPass) failed = true;
    console.log(`${rate >= minPass ? 'PASS' : 'FAIL'}  ${kind.padEnd(17)} ${language}  generated ${ai_}/${runs}  fallback reasons ${JSON.stringify(reasons)}  max ${Math.max(...times)} ms`);
    for (const t of texts) console.log(`        “${t}”`);
  }
}
console.log('\nReview the Icelandic texts with a native speaker before turning generated wording on for everyone.');
process.exit(failed ? 1 : 0);
