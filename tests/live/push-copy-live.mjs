#!/usr/bin/env node
/**
 * OPT-IN live evaluation of coach reminder copy (NOT mocked): node tests/live/push-copy-live.mjs
 *
 * Roadmap item 9: run this with the production provider settings before broadly enabling generated reminder wording
 * (PUSH_AI_COPY). It calls the real writeCopy() (supabase/functions/_shared/push/copy.ts, bundled in memory with
 * esbuild) for every reminder kind in English and Icelandic, LC_PUSH_COPY_RUNS times each (default 3), with a consenting
 * fixture (training + nutrition shared), and reports per kind/language: how often the model's text passed validation
 * (validateCopy: JSON shape, ≤ 140 code points, language, no guilt/targets/numbers), how often the fallback was used,
 * latency, and the generated texts for a human (native Icelandic) review. Every text that passed validation is also
 * judged semantically by a second model call against the copy contract (guilt or shame, compensation, exercise or
 * food prescriptions, dietary targets, claims that the person skipped training or eating, wrong language, not
 * supportive); any violation fails the run. It never sends a notification and touches
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
const { resolveProvider, createMessage } = await import(
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
const JUDGE = [
  'You audit one push-notification text against a contract. Reply with exactly one JSON object and nothing else:',
  '{"guilt": bool, "compensation": bool, "exercise_prescription": bool, "food_prescription": bool, "target_or_measurement": bool,',
  '"claims_skipped": bool, "language_ok": bool, "supportive": bool}.',
  'guilt: shames or blames. compensation: asks to make up for something. exercise_prescription: names or suggests exercises/activities.',
  'food_prescription: tells what/when/how much to eat or drink. target_or_measurement: numbers, calories, weight, body measures.',
  'claims_skipped: states or implies the person skipped/missed training or eating. language_ok: written entirely in the requested language.',
  'supportive: warm and low-pressure.',
].join(' ');
async function judge(text, language) {
  const res = await createMessage(
    { provider: provider.provider, apiKey: provider.apiKey, model: provider.model, baseUrl: provider.baseUrl, apiVersion: provider.apiVersion,
      reasoningEffort: provider.reasoningEffort, reasoningAllowance: provider.reasoningAllowance, maxTokens: 200, maxRetries: 1, fetch },
    { system: JUDGE, messages: [{ role: 'user', content: JSON.stringify({ requested_language: language === 'is' ? 'Icelandic' : 'English', text }) }] },
  );
  const raw = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    const v = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    const bad = ['guilt', 'compensation', 'exercise_prescription', 'food_prescription', 'target_or_measurement', 'claims_skipped'].filter((k) => v[k] === true);
    if (v.language_ok !== true) bad.push('language');
    if (v.supportive !== true) bad.push('not_supportive');
    return bad;
  } catch {
    return ['judge_unparseable'];
  }
}
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
    for (const t of texts) {
      const bad = await judge(t, language);
      if (bad.length) failed = true;
      console.log(`        ${bad.length ? `SEMANTIC FAIL (${bad.join(', ')})` : 'ok'}  “${t}”`);
    }
  }
}
console.log('\nReview the Icelandic texts with a native speaker before turning generated wording on for everyone.');
process.exit(failed ? 1 : 0);
