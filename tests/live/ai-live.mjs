#!/usr/bin/env node
/**
 * OPT-IN live AI provider check (NOT mocked): node tests/live/ai-live.mjs
 *
 * Runs the real ai-coach request handler (supabase/functions/_shared/ai/coach.ts, bundled in memory with esbuild)
 * against the REAL provider configured by env — OPENAI_API_KEY (+ OPENAI_MODEL, OPENAI_BASE_URL …) or
 * ANTHROPIC_API_KEY (+ ANTHROPIC_MODEL …), AI_PROVIDER to pick — with an in-memory fixture user instead of
 * Supabase. Scenario (repair brief §3): saved 3-session plan (Full body A/B/C Mon/Wed/Fri), A done on Monday,
 * today Wednesday, the user says "I can only train twice this week". Prints the reply, the "Why this?" part and
 * the structured week plan, then soft checks. Costs one or two provider calls.
 *
 * Without a key it prints BLOCKED and exits 0. Exit 1 only when the provider call fails.
 */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
  console.log('BLOCKED: set OPENAI_API_KEY or ANTHROPIC_API_KEY (and optionally AI_PROVIDER / *_MODEL) to run the live AI check.');
  process.exit(0);
}

const out = await build({ entryPoints: [path.join(ROOT, 'supabase/functions/_shared/ai/coach.ts')], bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent' });
const { handleAiCoach } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);

const UID = '11111111-1111-4111-8111-111111111111';
const PID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const rx = (id, exerciseId, sets = 3) => ({ id, exerciseId, sets, repMin: 8, repMax: 12, targetRir: 2, restSec: 90 });
const exercises = [
  { id: 'goblet-squat', name: 'Goblet squat', pattern: 'squat', equipment: ['dumbbell'], tracking: 'weight_reps' },
  { id: 'dumbbell-row', name: 'Dumbbell row', pattern: 'horizontal_pull', equipment: ['dumbbell', 'bench'], tracking: 'weight_reps' },
  { id: 'dumbbell-bench-press', name: 'Dumbbell bench press', pattern: 'horizontal_push', equipment: ['dumbbell', 'bench'], tracking: 'weight_reps' },
  { id: 'romanian-deadlift', name: 'Romanian deadlift', pattern: 'hinge', equipment: ['dumbbell'], tracking: 'weight_reps' },
  { id: 'dumbbell-overhead-press', name: 'Dumbbell overhead press', pattern: 'vertical_push', equipment: ['dumbbell'], tracking: 'weight_reps' },
];
const program = {
  id: PID,
  payload: {
    id: PID, name: 'Full body 3x', active: true, currentVersion: 2, startDate: '2026-10-05', managedBy: { kind: 'self' }, overrides: [],
    versions: [{
      version: 2, weeks: 8,
      templates: [
        { id: 'fb-a', name: 'Full body A', kind: 'lifting', estimatedMinutes: 45, exercises: [rx('s1', 'goblet-squat'), rx('s2', 'dumbbell-bench-press'), rx('s3', 'dumbbell-row')] },
        { id: 'fb-b', name: 'Full body B', kind: 'lifting', estimatedMinutes: 45, exercises: [rx('s1', 'romanian-deadlift'), rx('s2', 'dumbbell-overhead-press'), rx('s3', 'dumbbell-row')] },
        { id: 'fb-c', name: 'Full body C', kind: 'lifting', estimatedMinutes: 45, exercises: [rx('s1', 'goblet-squat'), rx('s2', 'dumbbell-bench-press'), rx('s3', 'romanian-deadlift')] },
      ],
      schedule: [{ weekday: 1, templateId: 'fb-a' }, { weekday: 3, templateId: 'fb-b' }, { weekday: 5, templateId: 'fb-c' }],
    }],
    inputs: { equipment: ['dumbbell', 'bench'], sessionMinutes: 45, liftingDaysPerWeek: 3, availableWeekdays: [1, 2, 3, 4, 5, 6] },
  },
};
const sessions = [{ id: 's-mon', name: 'Full body A', status: 'completed', date: '2026-10-26', templateId: 'fb-a', plannedDate: '2026-10-26', programId: PID, startedAt: 0, endedAt: 2_700_000, exercises: [] }];
let stored = null;
const db = {
  getSettings: async () => ({ enabled: true, paused: false, consentAt: '2026-10-20T08:00:00Z', consentVersion: `2026-10-29:${(process.env.AI_PROVIDER || (process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY ? 'openai' : 'anthropic')).toLowerCase()}`, scopes: { profile: true, training: true, measurements: false, nutrition: false }, scopesChangedAt: null, profileNotes: 'Training setup: 2 training days a week; 30-minute sessions.' }),
  getExchange: async () => null,
  checkAndCountUsage: async () => 39,
  getUsage: async (_u, day) => ({ day, requests: 0, inputTokens: 0, outputTokens: 0, costUsd: null }),
  getAccountState: async () => ({ settings: { units: { weight: 'kg' }, timeZone: 'UTC', weekStart: 1 }, profile: { goal: 'build_muscle', experience: 'intermediate', limitations: ['knee'] } }),
  getActiveProgram: async () => program,
  getRecentSessions: async () => sessions,
  getGoals: async () => [],
  getBodyweight: async () => [],
  getFoodLogs: async () => [],
  getHistory: async () => [],
  recordExchange: async (_uid, input) => {
    stored = input;
    return { reply: { id: 'live-reply', role: 'assistant', content: input.reply.content, createdAt: new Date().toISOString(), grounding: input.reply.grounding, why: input.reply.why ?? null, action: input.reply.action ?? null }, proposal: null, duplicate: false };
  },
  getExercises: async () => exercises,
  getRecipes: async () => [],
  getIngredients: async () => [],
};
const events = [];
const res = await handleAiCoach(
  { db, env: (k) => process.env[k], fetch: globalThis.fetch, now: () => new Date('2026-10-28T12:00:00Z'), log: (e, f) => events.push({ e, ...f }) },
  UID,
  { action: 'send', id: '00000000-0000-4000-8000-00000000a1ce', text: 'I can only train twice this week', mode: 'chat' },
);
if (res.status !== 200) {
  console.log(`FAIL: provider call returned ${res.status} ${JSON.stringify(res.body)}`);
  process.exit(1);
}
const reply = res.body.reply;
console.log('LIVE provider reply (two-sessions scenario)\n');
console.log(reply.content);
console.log('\n— Why this? —\n' + (reply.why ?? '(none)'));
console.log('\n— Week plan —\n' + JSON.stringify(reply.action, null, 2));
console.log('\n— Log —\n' + JSON.stringify(events));
const words = (reply.content.match(/\S+/g) ?? []).length;
const checks = [
  ['offers a structured this-week plan', !!reply.action],
  ['exactly one more session (Monday counts)', reply.action?.sessions?.length === 1],
  ['picks an actual remaining plan session', ['fb-b', 'fb-c'].includes(reply.action?.sessions?.[0]?.templateId)],
  ['mentions the usual schedule next week', /next week/i.test(reply.content)],
  ['does not ask which split', !/upper\s*\/\s*lower|which split|full[- ]body or/i.test(reply.content)],
  [`concise (≤ 120 words; got ${words})`, words <= 120],
  ['does not end with a question', !/\?\s*$/.test(reply.content)],
];
console.log('\nSoft checks (model behaviour can vary):');
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'WARN'}  ${name}`);
void stored;
