/**
 * Coach reminder copy (roadmap item 9, phase 1). The model writes ONLY the notification body; title, recipient, URL,
 * timing, eligibility and deduplication stay deterministic (push_check / send.ts).
 *
 *  - Input to the model: the reminder kind, the effective language (en / is), a supportive tone and the approved
 *    fallback sentence as a writing reference. Never identity, chat, workout names, foods, measurements or targets.
 *  - Output: exactly { "body": "…" }, plain text, at most 140 Unicode code points, in the requested language.
 *  - Always supportive, whatever the chat coach style. No guilt, compensation, exercise prescriptions, dietary targets
 *    or claims that someone skipped exercise or eating (validateCopy rejects those, and anything else → fallback).
 *  - Off unless the function secret PUSH_AI_COPY=on (set it after the live EN/IS evaluation, tests/live/push-copy-live.mjs).
 *  - Needs: a configured provider, the training assistant enabled and not paused, consent for the configured provider,
 *    and the Training (workout / missed) or Nutrition (food) sharing scope. Otherwise zero model calls.
 *  - Emoji: none, except ONE optional trailing 💪 or 🙌 on workout_reminder (the whole text still counts toward the 140
 *    code points; only that trailing emoji is exempt from the content checks). Missed-workout and food nudges stay
 *    emoji-free and low-pressure.
 *  - Model: independent of the chat default. With OpenAI, PUSH_COPY_MODEL (default gpt-5.4-mini) with
 *    PUSH_COPY_REASONING_EFFORT (default none) and PUSH_COPY_REASONING_TOKEN_ALLOWANCE (0 for none, else 512); non-reasoning
 *    models get no reasoning fields. Changing OPENAI_MODEL never changes reminder copy.
 *  - One attempt per event, 3-second total timeout, no retries, small output and reasoning budget. Any failure →
 *    the approved fallback. Usage is reported as counts; bodies are never logged. Nothing here touches chat history or
 *    the chat daily allowance.
 */
// @ts-ignore Deno requires the .ts extension; the app tsconfig does not enable allowImportingTsExtensions.
import { sharedT, type Language } from '../i18n/core.ts';
// @ts-ignore see above
import { compatibleReasoningEffort, createMessage, isOpenAiReasoningModel, resolveProvider, type ProviderId } from '../ai/provider.ts';
// @ts-ignore see above
import { consentedProvider } from '../ai/consent.ts';
// @ts-ignore see above
import { detectLang } from '../ai/lang.ts';
// @ts-ignore see above
import type { FetchLike } from '../ai/types.ts';

export type CoachKind = 'workout_reminder' | 'missed_nudge' | 'food_unlogged';
export const COACH_KINDS: readonly CoachKind[] = ['workout_reminder', 'missed_nudge', 'food_unlogged'];
export const isCoachKind = (k: string): k is CoachKind => (COACH_KINDS as readonly string[]).includes(k);

export const COPY_MAX_CODE_POINTS = 140;
export const COPY_TIMEOUT_MS = 3000;
/** Push copy defaults (OpenAI), deliberately separate from the chat defaults in ../ai/provider.ts. */
export const DEFAULT_PUSH_OPENAI_MODEL = 'gpt-5.4-mini';
/** "none" since gpt-5.4-mini (~1.1 s, well inside COPY_TIMEOUT_MS); mapped per model by compatibleReasoningEffort. */
export const DEFAULT_PUSH_REASONING_EFFORT = 'none';
/** Hidden-reasoning allowance (and its cap) for any effort other than "none", which gets 0 by default. */
export const DEFAULT_PUSH_REASONING_ALLOWANCE = 512;
/** The only emoji generated copy may carry: one, trailing, on workout_reminder. */
export const WORKOUT_REMINDER_EMOJIS: readonly string[] = ['💪', '🙌'];

/** Below this much remaining worker time there is no model call (fallback). */
export const COPY_MIN_BUDGET_MS = 1200;

export interface CopyAiSettings {
  enabled?: boolean;
  paused?: boolean;
  consentAt?: string | null;
  consentVersion?: string | null;
  training?: boolean;
  nutrition?: boolean;
}
export interface FinalCopy {
  title: string;
  body: string;
  language: Language;
  source: 'ai' | 'fallback';
}

const KEYS: Record<CoachKind, { title: 'push.coachWorkout.title' | 'push.coachMissed.title' | 'push.coachFood.title'; body: 'push.coachWorkout.body' | 'push.coachMissed.body' | 'push.coachFood.body' }> = {
  workout_reminder: { title: 'push.coachWorkout.title', body: 'push.coachWorkout.body' },
  missed_nudge: { title: 'push.coachMissed.title', body: 'push.coachMissed.body' },
  food_unlogged: { title: 'push.coachFood.title', body: 'push.coachFood.body' },
};
export const COACH_URL: Record<CoachKind, string> = { workout_reminder: '/', missed_nudge: '/', food_unlogged: '/nutrition/log' };
export const COACH_TAG: Record<CoachKind, string> = { workout_reminder: 'workout', missed_nudge: 'workout', food_unlogged: 'food' };

export function coachTitle(kind: CoachKind, language: Language): string {
  return sharedT(language).t(KEYS[kind].title);
}
/** The approved fallback body (exact dictionary text). */
export function fallbackBody(kind: CoachKind, language: Language): string {
  return sharedT(language).t(KEYS[kind].body);
}
export function fallbackCopy(kind: CoachKind, language: Language): FinalCopy {
  return { title: coachTitle(kind, language), body: fallbackBody(kind, language), language, source: 'fallback' };
}

/** May generated wording be used for this reminder? (Rule-based reminders work regardless.) */
export function aiCopyAllowed(kind: CoachKind, ai: CopyAiSettings | null | undefined, provider: ProviderId | null): boolean {
  if (!ai || !provider || !ai.enabled || ai.paused) return false;
  if (consentedProvider({ consentAt: ai.consentAt ?? null, consentVersion: ai.consentVersion ?? null }) !== provider) return false;
  return kind === 'food_unlogged' ? ai.nutrition === true : ai.training === true;
}

const codePoints = (s: string) => [...s].length;
const IS_CHARS = /[áðéíóúýþæöÁÐÉÍÓÚÝÞÆÖ]/;
/**
 * Content the copy contract forbids (any match → fallback):
 * guilt/shame/compensation; claims that someone skipped training or eating; exercise prescriptions (exercise names,
 * "try/do some …"); food or eating prescriptions and dietary targets; numbers, measurements and units; health claims;
 * links, markup and emoji. English and Icelandic stems.
 */
const FORBIDDEN = [
  // guilt, shame, compensation, pressure
  /\b(skipp\w*|miss(ed|ing)|fail\w*|lazy|guilt\w*|asham\w*|shame\w*|excuse\w*|make up for|catch up|compensat\w*|burn (it )?off|earn (it|your)|no excuses?|must|have to|should|don[’']?t give up|push (yourself|through))\b/i,
  /\b(didn[’']?t|did not|haven[’']?t|have not|forgot to|forgotten to) (eat|train|work ?out|exercise|log|do)\b/i,
  // exercise prescriptions and named exercises / activities
  /\b(try|do|add|get in|squeeze in|start with) (some|a few|\d+|an? (quick|short|easy|light))\b/i,
  /\b(squat\w*|lunge\w*|push-?ups?|pull-?ups?|sit-?ups?|crunch\w*|plank\w*|burpee\w*|deadlift\w*|bench\w*|press(es)?|curls?|rows?|jog\w*|run(s|ning)?|sprint\w*|cardio|hiit|stretch\w*|yoga|walk(s|ing)?|steps|laps?|cycl\w*|swim\w*|hike\w*)\b/i,
  // eating prescriptions, foods and targets
  /\b(eat|eating|ate|drink|drinking|snack\w*|meal\w*|breakfast|lunch|dinner|protein|carb\w*|fat|fats|sugar\w*|calori\w*|kcal|macro\w*|diet\w*|fasting|hungry|portion\w*|water|vegetables?|fruit\w*)\b/i,
  // measurements, units, weight, health
  /\b(gram\w*|kilo\w*|kg|lbs?|pounds?|weigh\w*|bmi|reps?|sets?|minutes?|mins?|hours?|km|miles?|calf|injur\w*|pain\w*|sick\w*|ill(ness)?|health\w*|body)\b/i,
  // Icelandic: guilt/skipping, exercises/activities, eating/food/targets, units/health
  /(slepp|misst|samvisk|skamm|leti|lat(ur|ir)\b|bæta upp|vinna upp|brenn|verður að|þarft að|átt að|hnébeygj|armbeygj|upphífing|kviðæfing|planka|réttstöð|bekkpress|hlaup|skokk|sprett|ganga\b|göngu|teygj|jóga|hjól|synd|borða|borðaðu|drekk|snarl|máltíð|morgunmat|hádegismat|kvöldmat|prótein|kolvetn|fitu|sykur|hitaeining|kalorí|megrun|fast[aið]|svang|vatn|grænmeti|ávext|kíló|grömm|gramm|þyngd|vigt|endurtekning|lot(a|ur)\b|mínút|klukkutím|meiðsl|verk(ur|i)\b|veik|heilsu|líkam|gerðu nokkr|prófaðu nokkr)/i,
  /\d/,
  /\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/u,
  /(https?:|www\.|[<>*_#`[\]{}|\\~^=@$%&+])/i,
];

/** Generated wording is used only when the deployment flag PUSH_AI_COPY=on is set (cached text included). */
export function aiCopyEnabled(env: ((name: string) => string | undefined) | null | undefined): boolean {
  return env?.('PUSH_AI_COPY')?.trim().toLowerCase() === 'on';
}

/**
 * Validates the model output. Returns the body, or null (→ fallback). The output must be EXACTLY a JSON object with one
 * string field "body": plain single-line text, 1–140 code points, in `language`, without forbidden content.
 */
export function validateCopy(raw: string, language: Language, kind: CoachKind): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== 'body') return null;
  const body = (parsed as { body: unknown }).body;
  if (typeof body !== 'string') return null;
  const text = body.trim();
  if (!text || text !== body || /[\r\n\t]/.test(text) || codePoints(text) > COPY_MAX_CODE_POINTS) return null;
  // Emoji policy: only workout_reminder may end with ONE permitted emoji; only that emoji is exempt from the checks.
  const content = kind === 'workout_reminder' ? stripTrailingEmoji(text) : text;
  if (!content) return null;
  if (FORBIDDEN.some((re) => re.test(content))) return null;
  // Language: Icelandic text needs Icelandic letters; English text must not have them (nor read as Icelandic).
  const detected = detectLang(content);
  if (language === 'is' ? !IS_CHARS.test(content) || detected === 'en' : IS_CHARS.test(content) || detected === 'is') return null;
  return text;
}

/** "… today 💪" → "… today"; anything else unchanged (so a second or different emoji still fails the checks). */
function stripTrailingEmoji(text: string): string {
  for (const e of WORKOUT_REMINDER_EMOJIS) {
    if (text.endsWith(e)) return text.slice(0, -e.length).trimEnd();
  }
  return text;
}

const EMOJI_RULE: Record<CoachKind, string> = {
  workout_reminder: 'optional: at most one emoji, 💪 or 🙌, only at the very end; no other emoji',
  missed_nudge: 'none',
  food_unlogged: 'none',
};

const TOPIC: Record<CoachKind, string> = {
  workout_reminder: 'a planned training day today; invite them to open Today in the app to see their workout',
  missed_nudge: 'a planned workout from yesterday that is still open; plans change, invite them to open Today and choose what works',
  food_unlogged: 'an optional prompt to update their food log; it is fine to do it whenever it suits them',
};

export const COPY_SYSTEM = [
  'You write the body text of one push notification for a fitness app. Reply with exactly one JSON object: {"body": "..."} and nothing else.',
  'Only invite the person to open the app when it suits them; do not name any exercise, activity, food, drink, meal, amount or body part.',
  `The body is plain text, one sentence or two short ones, at most ${COPY_MAX_CODE_POINTS} characters, with no links, numbers, markdown or quotes.`,
  'Emoji: follow the "emoji" field exactly. For "kind": "workout_reminder" you may end with one 💪 or 🙌; missed_nudge and food_unlogged stay emoji-free.',
  'Tone: lightly upbeat, warm, supportive and low-pressure, like a friendly nudge; never hype. The person decides if and when to act.',
  'Never use guilt or shame, never suggest compensating or making up for anything, never prescribe exercises, durations, foods, calories or targets,',
  'and never state or imply that the person skipped, missed or failed to train or eat (you do not know that).',
  'Do not mention names, workouts, foods, body measurements or health. Write in the requested language only; for Icelandic, write natural, correct Icelandic.',
].join(' ');

export interface PushModel {
  model: string;
  reasoningEffort?: string;
  reasoningAllowance: number;
}

/**
 * The reminder-copy model, resolved independently of the chat defaults: an OpenAI deployment uses PUSH_COPY_MODEL
 * (default gpt-5.4-mini) with PUSH_COPY_REASONING_EFFORT (default none; compatibleReasoningEffort maps none/minimal to
 * what the model accepts: minimal on gpt-5 / gpt-5-mini / gpt-5-nano, low on o-series; "off" sends no effort) and
 * PUSH_COPY_REASONING_TOKEN_ALLOWANCE (default 0 for none and 512 otherwise, capped at 512). Non-reasoning models get
 * no reasoning fields.
 * Anthropic keeps PUSH_COPY_MODEL or the configured chat model (no reasoning fields either way).
 * Shared with tests/live/push-copy-live.mjs.
 */
export function resolvePushModel(env: (name: string) => string | undefined, provider: { provider: ProviderId; model: string }): PushModel {
  const get = (k: string) => env(k)?.trim() || undefined;
  if (provider.provider !== 'openai') return { model: get('PUSH_COPY_MODEL') ?? provider.model, reasoningEffort: undefined, reasoningAllowance: 0 };
  const model = get('PUSH_COPY_MODEL') ?? DEFAULT_PUSH_OPENAI_MODEL;
  const effortEnv = get('PUSH_COPY_REASONING_EFFORT')?.toLowerCase();
  const reasoningEffort =
    !isOpenAiReasoningModel(model) || effortEnv === 'off' ? undefined : compatibleReasoningEffort(model, effortEnv ?? DEFAULT_PUSH_REASONING_EFFORT);
  const raw = get('PUSH_COPY_REASONING_TOKEN_ALLOWANCE');
  const n = raw ? Number(raw) : NaN;
  const fallbackAllowance = reasoningEffort === 'none' ? 0 : DEFAULT_PUSH_REASONING_ALLOWANCE;
  const allowance = Number.isFinite(n) && n >= 0 ? Math.min(DEFAULT_PUSH_REASONING_ALLOWANCE, Math.floor(n)) : fallbackAllowance;
  const reasoningAllowance = reasoningEffort ? allowance : 0;
  return { model, reasoningEffort, reasoningAllowance };
}

export interface CopyDeps {
  env: (name: string) => string | undefined;
  fetch: FetchLike;
  now?: () => number;
}
export interface CopyResult extends FinalCopy {
  /** Why the fallback was used (for counts only). */
  reason?: 'not_allowed' | 'not_configured' | 'budget' | 'invalid' | 'provider';
  modelCalled: boolean;
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * Writes the body for one reminder: one model attempt within min(3 s, budgetMs), else the approved fallback.
 * The returned copy is in `language`.
 */
export async function writeCopy(deps: CopyDeps, kind: CoachKind, language: Language, ai: CopyAiSettings | null | undefined, budgetMs: number): Promise<CopyResult> {
  const fb = fallbackCopy(kind, language);
  const provider = resolveProvider(deps.env);
  if (!provider) return { ...fb, reason: 'not_configured', modelCalled: false };
  if (!aiCopyAllowed(kind, ai, provider.provider)) return { ...fb, reason: 'not_allowed', modelCalled: false };
  // Generated wording stays off until the owner enables it after the live EN/IS evaluation (tests/live/push-copy-live.mjs).
  if (!aiCopyEnabled(deps.env)) return { ...fb, reason: 'not_allowed', modelCalled: false };
  const timeout = Math.min(COPY_TIMEOUT_MS, Math.floor(budgetMs));
  if (!(timeout >= COPY_MIN_BUDGET_MS)) return { ...fb, reason: 'budget', modelCalled: false };
  const now = deps.now ?? Date.now;
  const pm = resolvePushModel(deps.env, provider);
  try {
    const res = await createMessage(
      {
        provider: provider.provider,
        apiKey: provider.apiKey,
        model: pm.model,
        baseUrl: provider.baseUrl,
        apiVersion: provider.apiVersion,
        reasoningEffort: pm.reasoningEffort,
        reasoningAllowance: pm.reasoningAllowance,
        maxTokens: 160,
        timeoutMs: timeout,
        maxRetries: 0,
        deadline: now() + timeout,
        fetch: deps.fetch,
        now,
      },
      {
        system: COPY_SYSTEM,
        messages: [
          {
            role: 'user',
            content: JSON.stringify({
              kind,
              reminder: TOPIC[kind],
              emoji: EMOJI_RULE[kind],
              language: language === 'is' ? 'Icelandic (is)' : 'English (en)',
              tone: 'supportive',
              reference: fb.body,
            }),
          },
        ],
      },
    );
    const usage = { inputTokens: Number(res.usage?.input_tokens) || 0, outputTokens: Number(res.usage?.output_tokens) || 0 };
    const text = res.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text).join('');
    const body = res.stop_reason === 'max_tokens' ? null : validateCopy(text, language, kind);
    if (!body) return { ...fb, reason: 'invalid', modelCalled: true, usage };
    return { title: fb.title, body, language, source: 'ai', modelCalled: true, usage };
  } catch {
    return { ...fb, reason: 'provider', modelCalled: true };
  }
}

/**
 * The copy to send after the final (dispatch) check: cached/generated copy is kept only when it matches the current
 * language and, for generated text, AI copy is still allowed. Otherwise the current-language fallback.
 */
export function finalizeCopy(kind: CoachKind, copy: { body: string; language: string; source: string } | null | undefined, language: Language, aiStillAllowed: boolean): FinalCopy {
  if (copy && copy.language === language && typeof copy.body === 'string' && copy.body) {
    if (copy.source === 'fallback' && copy.body === fallbackBody(kind, language)) return fallbackCopy(kind, language);
    if (copy.source === 'ai' && aiStillAllowed && validateCopy(JSON.stringify({ body: copy.body }), language, kind) === copy.body) {
      return { title: coachTitle(kind, language), body: copy.body, language, source: 'ai' };
    }
  }
  return fallbackCopy(kind, language);
}
