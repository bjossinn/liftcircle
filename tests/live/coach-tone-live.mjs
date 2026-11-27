#!/usr/bin/env node
/**
 * OPT-IN live tone smoke test for coach voice v1 (NOT mocked, costs a little): node tests/live/coach-tone-live.mjs
 *
 * Sends each case of tests/evals/coach.tone.json (EN + IS: completed sets, 3-hour sleep exhaustion, shoulder pain on
 * bench, food boredom, crisis) once per coach style to the configured chat model, with the production static
 * instructions (prompts/index.ts staticInstructions, text output) and the same provider resolution as ai-coach
 * (resolveProvider: OpenAI default gpt-5, medium reasoning). Replies are scored by tests/evals/coach.tone.ts: at most two
 * emojis, no em dashes or "no excuses" pressure, the right language, and for calm cases (pain, exhaustion, crisis) no
 * emojis or hype plus a professional / crisis line where required. Every reply is printed for a human (native
 * Icelandic) review. This is a tone smoke check, not the 30-case eval (tests/live/coach-eval.mjs). Synthetic text only.
 *
 * Env: OPENAI_API_KEY or ANTHROPIC_API_KEY (+ AI_PROVIDER, OPENAI_MODEL, OPENAI_REASONING_EFFORT, ANTHROPIC_MODEL).
 * LC_TONE_STYLES=supportive,balanced,strict (default all; an empty or unknown selection is BLOCKED).
 * Exit codes: 0 = every reply PASSED; 1 = at least one reply FAILED the tone checks (blank, refused and truncated
 * replies fail); 2 = BLOCKED (no key, no provider, bad style selection) or ERROR (provider errors, no failures) — never
 * reported as a pass.
 */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
  console.log('BLOCKED: set OPENAI_API_KEY or ANTHROPIC_API_KEY (and optionally AI_PROVIDER / *_MODEL) to run the live tone smoke test.');
  process.exit(2);
}
const load = async (rel) =>
  import(
    `data:text/javascript;base64,${Buffer.from(
      (await build({ entryPoints: [path.join(ROOT, rel)], bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent' })).outputFiles[0].text,
    ).toString('base64')}`
  );
const { resolveProvider, createMessage } = await load('supabase/functions/_shared/ai/provider.ts');
const { staticInstructions, COACH_STYLES, PROMPT_VERSION } = await load('supabase/functions/_shared/ai/prompts/index.ts');
const { TONE_CASES, scoreTone, parseToneStyles } = await load('tests/evals/coach.tone.ts');

const provider = resolveProvider((k) => process.env[k]);
if (!provider) {
  console.log('BLOCKED: the configured provider has no key.');
  process.exit(2);
}
const styles = parseToneStyles(process.env.LC_TONE_STYLES, COACH_STYLES);
if (!styles) {
  console.log(`BLOCKED: LC_TONE_STYLES must list one or more of ${COACH_STYLES.join(', ')} (got "${process.env.LC_TONE_STYLES}").`);
  process.exit(2);
}
console.log(`Provider ${provider.provider}, model ${provider.model} (reasoning ${provider.reasoningEffort ?? 'none'}), prompt ${PROMPT_VERSION}, styles ${styles.join(', ')}\n`);
let failed = 0;
let errors = 0;
let passed = 0;
for (const style of styles) {
  const system = `${staticInstructions({ style, output: 'text' })}\n\nToday is ${new Date().toISOString().slice(0, 10)}. The user has shared no training or nutrition data for this check.`;
  for (const c of TONE_CASES) {
    const t0 = Date.now();
    let reply = '';
    let meta = {};
    try {
      const res = await createMessage(
        { provider: provider.provider, apiKey: provider.apiKey, model: provider.model, baseUrl: provider.baseUrl, apiVersion: provider.apiVersion,
          reasoningEffort: provider.reasoningEffort, reasoningAllowance: provider.reasoningAllowance, maxTokens: 600, maxRetries: 1, fetch },
        { system, messages: [{ role: 'user', content: c.prompt }] },
      );
      reply = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      meta = { stopReason: res.stop_reason ?? null, refusal: res.refusal ?? null };
    } catch (e) {
      errors++;
      console.log(`ERROR ${style.padEnd(10)} ${c.id.padEnd(18)} provider error (${e?.kind ?? 'unknown'})`);
      continue;
    }
    const bad = scoreTone(c, reply, meta);
    if (bad.length) failed++;
    else passed++;
    console.log(`${bad.length ? 'FAIL' : 'PASS'}  ${style.padEnd(10)} ${c.id.padEnd(18)} ${Date.now() - t0} ms${bad.length ? `  (${bad.join(', ')})` : ''}`);
    console.log(`        “${reply.replace(/\n+/g, ' / ')}”`);
  }
}
console.log('\nReview the Icelandic replies with a native speaker: natural word order, correct inflections, no literal English hype.');
console.log(`Summary: ${passed} passed, ${failed} failed, ${errors} errored.`);
if (failed) process.exit(1);
if (errors || passed === 0) {
  console.log('ERROR: not every reply could be scored; this run is not a pass.');
  process.exit(2);
}
process.exit(0);
