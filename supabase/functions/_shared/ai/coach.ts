/**
 * ai-coach request handling (pure; the Deno entry point injects env, fetch and the data accessor).
 *
 *   POST {action:'status'}                          → availability + today's usage
 *   POST {action:'send', id, text, mode}            → {reply, proposal}
 *
 * The caller's identity is ONLY the `uid` argument (the verified JWT subject). Any other field in the body
 * (userId, clientId, scopes, …) is ignored. Order for 'send': input check → configured? → settings
 * enabled & not paused (409) → idempotent replay of a stored exchange → daily limit (429) → context →
 * provider (≤ 3 rounds, tools) → proposal validation → atomic record.
 */
import type { AiAction, AiDb, AiSettingsRow, ApiMessage, ContentBlock, FetchLike, ProposalJson, StoredMessage } from './types.ts';
// @ts-ignore Deno requires the .ts extension; the app tsconfig does not enable allowImportingTsExtensions.
import { buildContext } from './context.ts';
// @ts-ignore see above
import { addUsage, AiUnavailableError, createMessage, estimateCostUsd, PROVIDER_NAMES, resolveProvider, type ProviderId } from './provider.ts';
// @ts-ignore see above
import { MAX_TOOL_ROUNDS, runTool, TOOL_DEFS, type ToolState } from './tools.ts';
// @ts-ignore see above
import { splitWhy, tidyReply, wordCount } from './reply.ts';
// @ts-ignore see above
import { guideFeaturesFromEnv, validateOpenLinks } from './appGuide.ts';
// @ts-ignore see above
import { humanizeDates } from './humanDates.ts';
// @ts-ignore Deno requires the .ts extension; the app tsconfig does not enable allowImportingTsExtensions.
import { replyLang, type Lang } from './lang.ts';
// @ts-ignore see above
import { asksForMealPlan, buildMealPlanAction, mealPlanIntentFromText } from './meals.ts';
// @ts-ignore see above
import { mealPlanBlocker } from './dataStatus.ts';
// @ts-ignore see above
import { looksLikeFullRecipe, mealPlanConflict, proposalConflict, summarizeMealPlan, summarizeProposal, summarizeRecipes, summarizeWeekPlan, weekPlanConflict } from './postcheck.ts';

export interface CoachDeps {
  db: AiDb;
  env: (name: string) => string | undefined;
  fetch: FetchLike;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Structured, content-free event log (never pass message text, notes or keys). */
  log?: (event: string, fields: Record<string, string | number | boolean | null>) => void;
}

export interface CoachResult {
  status: number;
  body: Record<string, unknown>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_TEXT = 2000;
const MAX_REPLY_CHARS = 12000;
const TOTAL_BUDGET_MS = 110_000; // stays under the Edge Function wall-clock limit

const intEnv = (deps: CoachDeps, name: string, dflt: number, min: number, max: number) => {
  const v = Number(deps.env(name));
  return Number.isFinite(v) && v >= min ? Math.min(max, Math.floor(v)) : dflt;
};

const err = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): CoachResult => ({
  status,
  body: { error, code, ...extra },
});

export function isConfigured(deps: CoachDeps): boolean {
  return resolveProvider(deps.env) !== null;
}

/** Consent is recorded per provider ("2026-10-29:openai"). Older versions without a suffix were given for Anthropic. */
export function consentProvider(version: string | null | undefined): ProviderId | null {
  if (!version) return null;
  const tail = version.includes(':') ? version.slice(version.lastIndexOf(':') + 1).toLowerCase() : 'anthropic';
  return tail === 'openai' || tail === 'anthropic' ? tail : null;
}

/** The provider this user agreed to; a consent recorded before versions existed counts as Anthropic. */
export function consentedProvider(s: { consentAt?: string | null; consentVersion?: string | null } | null | undefined): ProviderId | null {
  if (!s?.consentAt) return null;
  return consentProvider(s.consentVersion || '2026-10-29');
}

export async function handleAiCoach(deps: CoachDeps, uid: string, rawBody: unknown): Promise<CoachResult> {
  const body = (rawBody && typeof rawBody === 'object' ? rawBody : {}) as Record<string, unknown>;
  if (!UUID_RE.test(uid)) return err(401, 'auth', 'You need to be signed in.');
  if (body.action === 'status') return status(deps, uid);
  if (body.action === 'send') return send(deps, uid, body);
  return err(400, 'bad_request', 'Unknown action.');
}

async function usageFor(deps: CoachDeps, uid: string) {
  const now = deps.now?.() ?? new Date();
  const day = now.toISOString().slice(0, 10); // ai_usage days are UTC
  const limit = intEnv(deps, 'AI_DAILY_REQUEST_LIMIT', 40, 0, 10_000);
  const u = await deps.db.getUsage(uid, day);
  return { day, requests: u?.requests ?? 0, inputTokens: u?.inputTokens ?? 0, outputTokens: u?.outputTokens ?? 0, limitRequests: limit };
}

async function status(deps: CoachDeps, uid: string): Promise<CoachResult> {
  const prov = resolveProvider(deps.env);
  const configured = prov !== null;
  const [settings, usage] = await Promise.all([deps.db.getSettings(uid), usageFor(deps, uid)]);
  return {
    status: 200,
    body: {
      ...(configured ? { available: true } : { available: false, reason: 'not_configured' }),
      configured,
      // Which company receives the data — shown in the consent and data explanations.
      ...(prov ? { provider: prov.provider, providerName: PROVIDER_NAMES[prov.provider] } : {}),
      consentCurrent: !!prov && consentedProvider(settings) === prov.provider,
      enabled: Boolean(settings?.enabled),
      paused: Boolean(settings?.paused),
      usage,
    },
  };
}

const SCOPE_IS: Record<string, string> = { profile: 'prófílinn þinn', training: 'æfingarnar þínar', measurements: 'mælingarnar þínar', nutrition: 'næringuna þína' };
/** "Thanks — I can see your training now." in the reply language (exported for tests). */
export function thanksLine(added: readonly string[], lang: Lang): string {
  if (lang === 'is') {
    const xs = added.map((k) => SCOPE_IS[k] ?? k);
    const list = xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} og ${xs[xs.length - 1]}`;
    return `Takk — nú sé ég ${list}.`;
  }
  return `Thanks — I can see your ${added.join(' and ')} now.`;
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

async function send(deps: CoachDeps, uid: string, body: Record<string, unknown>): Promise<CoachResult> {
  // Only these four fields are read from the request.
  const id = typeof body.id === 'string' ? body.id : '';
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const mode: 'chat' | 'checkin_review' = body.mode === 'checkin_review' ? 'checkin_review' : 'chat';
  // Changes still only on the user's device after the app's pre-send sync (1.0.3 sync barrier); a count, nothing else.
  const unsynced = Math.max(0, Math.min(1000, Math.round(Number(body.unsynced) || 0)));
  if (!UUID_RE.test(id)) return err(400, 'bad_request', 'A valid message id is required.');
  if (!text) return err(400, 'bad_request', 'Write a message first.');
  if (text.length > MAX_TEXT) return err(400, 'bad_request', `Messages can be at most ${MAX_TEXT} characters.`);

  const prov = resolveProvider(deps.env);
  if (!prov) return err(503, 'ai_unavailable', 'The training assistant is not configured on this server.', { reason: 'not_configured' });

  const settings = await deps.db.getSettings(uid);
  if (!settings?.enabled) return err(409, 'ai_disabled', 'The training assistant is turned off. Turn it on in training assistant settings.', { reason: 'disabled' });
  if (settings.paused) return err(409, 'ai_paused', 'The training assistant is paused. Resume it in training assistant settings.', { reason: 'disabled' });
  // The user agreed to send data to one specific provider; a provider switch on the server needs a fresh agreement.
  if (consentedProvider(settings) !== prov.provider)
    return err(409, 'consent_required', `The training assistant now uses ${PROVIDER_NAMES[prov.provider]}. Review what’s sent and agree again in training assistant setup.`, {
      reason: 'consent_required',
      provider: prov.provider,
    });

  const stored = await deps.db.getExchange(uid, id);
  if (stored) return { status: 200, body: { reply: stored.reply, proposal: stored.proposal ?? null, duplicate: true } };

  const limit = intEnv(deps, 'AI_DAILY_REQUEST_LIMIT', 40, 0, 10_000);
  // This run's attempt id: only it may settle the request as failed (a newer attempt may have taken over).
  let attempt: string | null = null;
  try {
    // Reserve this message id and count it (1.0.3). A replay while the first request is still running must not start a
    // second generation (double cost, and a second action card for the same message).
    if (deps.db.beginRequest) {
      const begun = await deps.db.beginRequest(uid, id, limit);
      if (begun.status === 'duplicate') {
        const again = await deps.db.getExchange(uid, id);
        if (again) return { status: 200, body: { reply: again.reply, proposal: again.proposal ?? null, duplicate: true } };
      }
      if (begun.status !== 'started') {
        deps.log?.('ai_in_progress', {});
        return err(409, 'in_progress', 'Still answering this message. It will appear in a moment.', { reason: 'in_progress' });
      }
      attempt = begun.attempt;
    } else await deps.db.checkAndCountUsage(uid, limit);
  } catch (e) {
    if ((e as { code?: string })?.code === 'PT429') {
      const usage = await usageFor(deps, uid).catch(() => null);
      return err(429, 'rate_limited', (e as Error).message || 'You’ve reached today’s training assistant limit.', { reason: 'rate_limited', usage });
    }
    throw e;
  }

  // Failure accounting (1.0.3): a request that fails gives its daily allowance back, and tokens from provider rounds that
  // did complete are booked as FAILED usage — never as a successful exchange. The database decides: the call is a no-op
  // unless this attempt still owns the running request (so a lost response after the answer was stored never refunds).
  const tally = { inputTokens: 0, outputTokens: 0 };
  let settled = false;
  const fail = async () => {
    if (settled) return;
    settled = true;
    try {
      if (attempt) await deps.db.failRequest?.(uid, id, attempt, { ...tally, costUsd: estimateCostUsd(tally, deps.env('AI_PRICE_INPUT_PER_MTOK'), deps.env('AI_PRICE_OUTPUT_PER_MTOK')) });
    } catch (e) {
      deps.log?.('ai_fail_request_error', { code: (e as { code?: string })?.code ?? null });
    }
  };
  const recordOnce = async <T,>(record: () => Promise<T>): Promise<T> => {
    const r = await record();
    settled = true; // stored: from here on the exchange counts as successful
    return r;
  };
  try {
    return await answer({ deps, uid, id, text, mode, unsynced, prov, settings, tally, fail, recordOnce });
  } catch (e) {
    await fail();
    throw e;
  }
}

/** Everything send() decided before the provider is called, plus the failure accounting hooks (1.0.3). */
interface Answering {
  deps: CoachDeps;
  uid: string;
  id: string;
  text: string;
  mode: 'chat' | 'checkin_review';
  unsynced: number;
  prov: NonNullable<ReturnType<typeof resolveProvider>>;
  settings: AiSettingsRow;
  tally: { inputTokens: number; outputTokens: number };
  fail: () => Promise<void>;
  recordOnce: <T>(record: () => Promise<T>) => Promise<T>;
}

async function answer(a: Answering): Promise<CoachResult> {
  const { deps, uid, id, text, mode, unsynced, prov, settings, tally, fail, recordOnce } = a;
  const now = deps.now?.() ?? new Date();
  const started = Date.now();
  // Hidden product areas (coach marketplace, social feed) stay out of the app guide and its links.
  const features = guideFeaturesFromEnv(deps.env);
  const ctx = await buildContext({ db: deps.db, uid, settings, text, mode, now, unsynced, features });
  const model = prov.model;
  const maxTokens = intEnv(deps, 'AI_MAX_OUTPUT_TOKENS', 1200, 64, 8192);
  const state: ToolState = { proposal: null, proposalAttempts: 0, weekPlan: null, weekAttempts: 0, mealPlan: null, mealPlanAttempts: 0, recipes: null };
  // The user's own words for this request — for a short follow-up ("ok, try now") also the original request — so tools
  // and the meal-plan fallback keep the user's restrictions even when the model's tool input drops them.
  const requestText = ctx.followUp && ctx.openRequest ? `${ctx.openRequest.text}\n${text}` : text;
  const conversation: ApiMessage[] = [...ctx.messages];
  let usage = { inputTokens: 0, outputTokens: 0 };
  let reply = '';
  let usedModel = model;
  let rounds = 0;
  const deadline = Date.now() + TOTAL_BUDGET_MS;

  try {
    for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
      rounds = round;
      const last = round === MAX_TOOL_ROUNDS;
      const res = await createMessage(
        {
          provider: prov.provider,
          apiKey: prov.apiKey,
          model,
          apiVersion: prov.apiVersion,
          baseUrl: prov.baseUrl,
          reasoningEffort: prov.reasoningEffort,
          reasoningAllowance: prov.reasoningAllowance,
          maxTokens,
          timeoutMs: intEnv(deps, 'AI_TIMEOUT_MS', 45_000, 1_000, 120_000),
          maxRetries: 2,
          fetch: deps.fetch,
          sleep: deps.sleep,
          random: deps.random,
          deadline,
        },
        // Last round: tools stay declared (the history contains tool blocks) but may not be called.
        { system: ctx.system, messages: conversation, tools: TOOL_DEFS, tool_choice: { type: last ? 'none' : 'auto' } },
      );
      usage = addUsage(usage, res.usage);
      tally.inputTokens = usage.inputTokens;
      tally.outputTokens = usage.outputTokens;
      if (typeof res.model === 'string') usedModel = res.model.slice(0, 100);
      const toolUses = res.content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
      if (res.stop_reason !== 'tool_use' || toolUses.length === 0 || last) {
        reply = textOf(res.content);
        if (res.stop_reason === 'max_tokens' && reply) reply += ' …';
        break;
      }
      conversation.push({ role: 'assistant', content: res.content });
      const results: ContentBlock[] = [];
      for (const tu of toolUses.slice(0, 4)) {
        const out = await runTool(tu.name, tu.input, {
          db: deps.db, facts: ctx.facts, catalog: ctx.catalog, state, week: ctx.week, trainingShared: ctx.trainingShared, messageId: id,
          today: ctx.today, nutrition: ctx.nutrition, account: ctx.account, requestText,
        });
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: out.content, ...(out.isError ? { is_error: true } : {}) });
      }
      for (const tu of toolUses.slice(4)) results.push({ type: 'tool_result', tool_use_id: tu.id, content: '{"error":"Too many tool calls."}', is_error: true });
      conversation.push({ role: 'user', content: results });
    }
  } catch (e) {
    if (e instanceof AiUnavailableError) {
      deps.log?.('ai_provider_error', { provider: prov.provider, kind: e.kind, status: e.status ?? null, reason: e.reason, rounds });
      await fail();
      return err(503, 'ai_unavailable', e.message, { reason: e.reason });
    }
    throw e;
  }

  // Reasoning goes to a separate, collapsed "Why this?" field; boilerplate the style rules forbid is trimmed.
  const split = splitWhy(reply);
  let why = split.why ? tidyReply(split.why) || null : null;
  reply = tidyReply(split.answer);
  // Server-written text follows the user's language (1.0.3): this message, else the open request, else earlier user
  // messages (newest first), else the model's own reply (it answers in the user's language); English by default.
  const earlier = ctx.messages.filter((m) => m.role === 'user' && typeof m.content === 'string').map((m) => m.content as string).reverse();
  const lang = replyLang(text, ctx.openRequest?.text, ...earlier, reply);
  // Users never see ISO dates.
  reply = humanizeDates(reply, ctx.today, ctx.facts.weekStart, lang);
  if (why) why = humanizeDates(why, ctx.today, ctx.facts.weekStart, lang);
  // Full recipes belong on the recipe screen, not in chat (rule in the prompt; logged when the model ignores it).
  const fullRecipe = looksLikeFullRecipe(reply);
  if (fullRecipe) deps.log?.('ai_full_recipe_warning', { words: wordCount(reply) });

  // "Make a meal plan and add it" (or "ok, try now" after one was blocked) must end in a real plan, never invented meals:
  // if the model didn't call propose_meal_plan, the server builds it from the intent in the user's OWN words (the
  // original request for a follow-up, plus this message) — "no fish, two meals a day" survives. If that can't be
  // built, the reply says so honestly instead of offering a plan that ignores what was asked.
  let replaced: string | null = null;
  let fallbackFailure: string | null = null;
  const resumed = ctx.followUp && ctx.openRequest?.intent === 'meal_plan';
  const wantsPlan = asksForMealPlan(text) || resumed;
  if (wantsPlan && !state.mealPlan && !state.weekPlan && !mealPlanBlocker(ctx.nutrition)) {
    const [recipes, ingredients] = await Promise.all([deps.db.getRecipes(), deps.db.getIngredients()]);
    const built = buildMealPlanAction(mealPlanIntentFromText(requestText), { facts: ctx.facts, account: ctx.account, today: ctx.today, nutrition: ctx.nutrition, messageId: id, recipes, ingredients, requestText });
    if (built.action) {
      state.mealPlan = built.action;
      replaced = 'meal_plan_fallback';
    } else if (built.errors.length) {
      fallbackFailure = built.errors[0];
      deps.log?.('ai_reply_replaced', { reason: 'meal_plan_fallback_failed' });
    }
  }

  // One structured action per reply: a this-week schedule change, else a meal plan, else recipe cards.
  const weekPlan = state.weekPlan ?? null;
  const action: AiAction | null = weekPlan ?? state.mealPlan ?? state.recipes ?? null;
  const p = state.proposal;

  // The card is the single source of truth: replace text that contradicts (or restates) it with a one-line summary.
  const proposalInfo = p
    ? {
        name: p.program.name,
        sessionsPerWeek: p.program.schedule.length,
        target: p.target,
        invalid: p.validationErrors.length > 0,
        schedule: p.program.schedule.map((s) => ({ weekday: s.weekday, name: p.program.templates.find((t) => t.id === s.templateId)?.name ?? s.templateId })),
      }
    : null;
  if (!replaced) {
    if (weekPlan && weekPlanConflict(reply, weekPlan, ctx.today)) replaced = 'week_plan_conflict';
    else if (state.mealPlan && action === state.mealPlan) {
      const names = (await deps.db.getRecipes()).map((r) => r.name);
      if (mealPlanConflict(reply, state.mealPlan, names)) replaced = 'meal_plan_conflict';
    } else if (proposalInfo && !proposalInfo.invalid && proposalConflict(reply, proposalInfo, ctx.today)) replaced = 'proposal_conflict';
  }
  if (fallbackFailure) reply = lang === 'is' ? `Ég gat ekki búið til matarplan með því sem þú baðst um: ${fallbackFailure}` : `I couldn't build that meal plan with what you asked for: ${fallbackFailure}`;
  if (replaced) {
    reply =
      weekPlan ? summarizeWeekPlan(weekPlan, ctx.today, ctx.facts.weekStart, lang)
        : state.mealPlan ? summarizeMealPlan(state.mealPlan, ctx.today, ctx.facts.weekStart, lang)
          : summarizeProposal(proposalInfo!, lang);
    // Keep the acknowledgement the prompt asked for when sharing just changed.
    if (ctx.sharingAdded.length) reply = `${thanksLine(ctx.sharingAdded, lang)} ${reply}`;
    deps.log?.('ai_reply_replaced', { reason: replaced });
  }

  // In-app links: ≤ 2 screen links and ≤ 3 recipe links whose path is in the app guide (param routes only with ids we
  // know); the rest are stripped, lead-in lines removed, and the kept links moved to the end.
  const known = { ...ctx.known };
  if (/\[\[\s*open\s*:\s*\/nutrition\/recipes\//i.test(reply)) known.recipe = new Set((await deps.db.getRecipes()).map((r) => r.id));
  const links = validateOpenLinks(reply, known, features);
  reply = links.text;
  if (!reply) {
    reply = weekPlan
      ? summarizeWeekPlan(weekPlan, ctx.today, ctx.facts.weekStart, lang)
      : state.mealPlan
        ? summarizeMealPlan(state.mealPlan, ctx.today, ctx.facts.weekStart, lang)
        : proposalInfo
          ? summarizeProposal(proposalInfo, lang)
          : state.recipes
            ? summarizeRecipes(state.recipes, lang)
            : lang === 'is' ? 'Því miður náði ég ekki að setja saman svar. Prófaðu að spyrja aftur.' : 'Sorry — I couldn’t put together a reply. Please try asking again.';
  }
  reply = reply.slice(0, MAX_REPLY_CHARS);
  const cost = estimateCostUsd(usage, deps.env('AI_PRICE_INPUT_PER_MTOK'), deps.env('AI_PRICE_OUTPUT_PER_MTOK'));
  const recorded = await recordOnce(() => deps.db.recordExchange(uid, {
    message: { id, content: text, mode },
    reply: { content: reply, grounding: ctx.grounding, model: usedModel, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, why, action },
    proposal: p
      ? {
          baseProgramId: p.baseProgramId,
          baseVersion: p.baseVersion,
          program: p.program as unknown as Record<string, unknown>,
          changeSummary: p.changeSummary,
          message: p.message,
          target: p.target,
          validationErrors: p.validationErrors,
          effectiveDate: null,
        }
      : null,
    usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: cost },
  }));
  deps.log?.('ai_send', {
    rounds,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    proposal: p ? (p.validationErrors.length ? 'invalid' : p.target) : null,
    ms: Date.now() - started,
    duplicate: Boolean(recorded.duplicate),
    words: wordCount(reply),
    why: Boolean(why),
    week_plan: Boolean(weekPlan),
    action: action?.kind ?? null,
    links: links.kept.length,
    links_removed: links.removed,
    replaced,
    full_recipe: fullRecipe,
    open_request: ctx.openRequest?.intent ?? null,
  });
  // Before the 2026-10-30 migration the database doesn't store why/action; still return them for this reply.
  const storedReply = { ...(recorded.reply as StoredMessage) };
  if (!recorded.duplicate && !('why' in storedReply)) storedReply.why = why;
  if (!recorded.duplicate && !('action' in storedReply)) storedReply.action = action;
  return {
    status: 200,
    body: { reply: storedReply, proposal: (recorded.proposal ?? null) as ProposalJson | null, duplicate: Boolean(recorded.duplicate) },
  };
}

