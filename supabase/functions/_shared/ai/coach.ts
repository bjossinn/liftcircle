/**
 * ai-coach request handling (pure; the Deno entry point injects env, fetch and the data accessor).
 *
 *   POST {action:'status'}                          → availability + today's usage
 *   POST {action:'send', id, text, mode, workout?}  → {reply, proposal}   (workout: live-workout snapshot, workout.ts)
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
import { addUsage, AiCancelledError, AiUnavailableError, createMessage, estimateCostUsd, PROVIDER_NAMES, resolveProvider, type ProviderId } from './provider.ts';
// @ts-ignore see above
import { consentProvider, consentedProvider } from './consent.ts';
// @ts-ignore see above
import { alternativesFor, buildSessionAdjustment, MAX_TOOL_ROUNDS, runTool, TOOL_DEFS, type ToolState } from './tools.ts';
// @ts-ignore see above
import { describeSessionAdjustment, parseWorkoutContext, type WorkoutContext } from './workout.ts';
// @ts-ignore see above
import { splitWhy, tidyReply, wordCount } from './reply.ts';
// @ts-ignore see above
import { outputFormatFor, parseEnvelope, REPLY_SCHEMA, REPLY_SCHEMA_NAME, type OutputFormat } from './structured.ts';
// @ts-ignore see above
import { guideFeaturesFromEnv, validateOpenLinks } from './appGuide.ts';
// @ts-ignore see above
import { humanizeDates } from './humanDates.ts';
// @ts-ignore Deno requires the .ts extension; the app tsconfig does not enable allowImportingTsExtensions.
import type { Lang } from './lang.ts';
// @ts-ignore see above
import { replyLanguageLine, replyLangSource, requestLanguage, resolveReplyLang } from './replyLanguage.ts';
// @ts-ignore see above
import { listText, sharedT } from '../i18n/core.ts';
// @ts-ignore see above
import { asksForMealPlan, buildMealPlanAction, clarificationNote, mealPlanIntentFromText, requestClarification } from './meals.ts';
// @ts-ignore see above
import { classifyRequest } from './requestSignals.ts';
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
  /** Progress for the streaming status line (item 10): a server-owned phase, emitted only when that work happens. */
  onPhase?: (phase: CoachPhase) => void;
}

/** Server-owned phases (item 10). The app maps each to ai.chat.status.<phase>; model text is never a status. */
export const COACH_PHASES = ['preparing', 'training', 'nutrition', 'recipes', 'planning', 'writing', 'checking', 'saving'] as const;
export type CoachPhase = (typeof COACH_PHASES)[number];

/** What this server supports (item 10). Older servers send none: the app keeps the JSON path and shows no Stop. */
export const PROTOCOL = { stream: 1, cancel: 1 } as const;

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

export { consentProvider, consentedProvider };

/**
 * A request either ends before any answer work starts (`done`: validation, consent, limits, duplicates, status, cancel…)
 * or holds a reserved, charged request whose answer is produced by `run` (`started`). The streaming entry point uses
 * this split to return normal JSON errors before any stream headers (item 10); both transports run the same `run`.
 */
export type CoachStart = { kind: 'done'; result: CoachResult } | { kind: 'started'; requestId: string; run: (hooks?: { onPhase?: (p: CoachPhase) => void }) => Promise<CoachResult> };

export async function handleAiCoach(deps: CoachDeps, uid: string, rawBody: unknown): Promise<CoachResult> {
  const s = await startAiCoach(deps, uid, rawBody);
  return s.kind === 'done' ? s.result : s.run();
}

export async function startAiCoach(deps: CoachDeps, uid: string, rawBody: unknown): Promise<CoachStart> {
  const body = (rawBody && typeof rawBody === 'object' ? rawBody : {}) as Record<string, unknown>;
  // The app language (Settings.language) only picks the language of text; it never affects identity, scopes or sharing.
  const { t } = sharedT(requestLanguage(body.language) ?? 'en');
  const done = (result: CoachResult): CoachStart => ({ kind: 'done', result });
  if (!UUID_RE.test(uid)) return done(err(401, 'auth', t('aiServer.auth.signIn')));
  if (body.action === 'status') return done(await status(deps, uid));
  if (body.action === 'send') return send(deps, uid, body);
  if (body.action === 'cancel') return done(await cancel(deps, uid, body));
  if (body.action === 'request_status') return done(await requestStatus(deps, uid, body));
  return done(err(400, 'bad_request', t('aiServer.error.unknownAction')));
}

/* ------------------------------------------------------------------ cancellation (item 10) */
const cancellationAvailable = async (deps: CoachDeps) => {
  try {
    return !!deps.db.cancelRequest && !!deps.db.requestStatus && (await deps.db.cancelSupported?.()) === true;
  } catch {
    return false;
  }
};

/** The stored exchange of a message, as a send would return it (never another user's: ownership is the JWT uid). */
async function exchangeBody(deps: CoachDeps, uid: string, id: string) {
  const ex = await deps.db.getExchange(uid, id);
  return ex ? { reply: ex.reply, proposal: ex.proposal ?? null, duplicate: true } : null;
}

/** POST {action:'cancel', id}: the user's Stop. Acknowledged only when the request is actually settled. */
async function cancel(deps: CoachDeps, uid: string, body: Record<string, unknown>): Promise<CoachResult> {
  const { t } = sharedT(requestLanguage(body.language) ?? 'en');
  const id = typeof body.id === 'string' ? body.id : '';
  if (!UUID_RE.test(id)) return err(400, 'bad_request', t('aiServer.error.invalidMessageId'));
  if (!(await cancellationAvailable(deps))) return err(501, 'cancel_unsupported', t('aiServer.error.unknownAction'));
  const r = await deps.db.cancelRequest!(uid, id);
  deps.log?.('ai_cancel', { status: r.status });
  if (r.status === 'succeeded') return { status: 200, body: { state: 'succeeded', ...(await exchangeBody(deps, uid, id)), usage: await usageFor(deps, uid) } };
  return { status: 200, body: { state: r.status, usage: await usageFor(deps, uid) } };
}

/** POST {action:'request_status', id}: where an interrupted or stopped request stands (same message id). */
async function requestStatus(deps: CoachDeps, uid: string, body: Record<string, unknown>): Promise<CoachResult> {
  const { t } = sharedT(requestLanguage(body.language) ?? 'en');
  const id = typeof body.id === 'string' ? body.id : '';
  if (!UUID_RE.test(id)) return err(400, 'bad_request', t('aiServer.error.invalidMessageId'));
  const stored = await exchangeBody(deps, uid, id);
  if (stored) return { status: 200, body: { state: 'succeeded', ...stored, usage: await usageFor(deps, uid) } };
  if (!(await cancellationAvailable(deps))) return err(501, 'cancel_unsupported', t('aiServer.error.unknownAction'));
  const state = await deps.db.requestStatus!(uid, id);
  return { status: 200, body: { state, usage: await usageFor(deps, uid) } };
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
      // Item 10: streaming is always available here; Stop only when the database has the cancellation functions.
      protocol: { stream: PROTOCOL.stream, ...((await cancellationAvailable(deps)) ? { cancel: PROTOCOL.cancel } : {}) },
    },
  };
}

/**
 * "Thanks — I can see your training now." in the reply language (exported for tests). `added` holds stable scope ids;
 * the labels are display-only (stored grounding keeps its English labels for sharedFromGrounding).
 */
export function thanksLine(added: readonly string[], lang: Lang): string {
  const tr = sharedT(lang);
  const scopes = lang === 'en'
    ? added.join(' and ')
    : listText(added.map((k) => (tr.has(`aiServer.scope.${k}`) ? tr.t(`aiServer.scope.${k}` as never).toLocaleLowerCase('is-IS') : k)), lang);
  return tr.t('aiServer.reply.sharingAcknowledged', { scopes });
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

async function send(deps: CoachDeps, uid: string, body: Record<string, unknown>): Promise<CoachStart> {
  const done = (result: CoachResult): CoachStart => ({ kind: 'done', result });
  // Only these fields are read from the request.
  const id = typeof body.id === 'string' ? body.id : '';
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const mode: 'chat' | 'checkin_review' = body.mode === 'checkin_review' ? 'checkin_review' : 'chat';
  // Changes still only on the user's device after the app's pre-send sync (1.0.3 sync barrier); a count, nothing else.
  const unsynced = Math.max(0, Math.min(1000, Math.round(Number(body.unsynced) || 0)));
  // A snapshot of the workout the message was sent from (contextual entry points); untrusted data, parsed and clamped.
  const workout = parseWorkoutContext(body.workout);
  // App language (validated; anything else is ignored). Error text follows it; codes stay stable.
  const setting = requestLanguage(body.language);
  const { t } = sharedT(setting ?? 'en');
  if (!UUID_RE.test(id)) return done(err(400, 'bad_request', t('aiServer.error.invalidMessageId')));
  if (!text) return done(err(400, 'bad_request', t('aiServer.error.emptyMessage')));
  if (text.length > MAX_TEXT) return done(err(400, 'bad_request', t('aiServer.error.messageTooLong', { max: MAX_TEXT })));

  const prov = resolveProvider(deps.env);
  if (!prov) return done(err(503, 'ai_unavailable', t('aiServer.error.notConfigured'), { reason: 'not_configured' }));

  const settings = await deps.db.getSettings(uid);
  if (!settings?.enabled) return done(err(409, 'ai_disabled', t('aiServer.error.disabled'), { reason: 'disabled' }));
  if (settings.paused) return done(err(409, 'ai_paused', t('aiServer.error.paused'), { reason: 'disabled' }));
  // The user agreed to send data to one specific provider; a provider switch on the server needs a fresh agreement.
  if (consentedProvider(settings) !== prov.provider)
    return done(err(409, 'consent_required', t('aiServer.error.consentRequired', { provider: PROVIDER_NAMES[prov.provider] }), {
      reason: 'consent_required',
      provider: prov.provider,
    }));

  const stored = await deps.db.getExchange(uid, id);
  if (stored) return done({ status: 200, body: { reply: stored.reply, proposal: stored.proposal ?? null, duplicate: true, usage: await usageFor(deps, uid).catch(() => null) } });

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
        if (again) return done({ status: 200, body: { reply: again.reply, proposal: again.proposal ?? null, duplicate: true, usage: await usageFor(deps, uid).catch(() => null) } });
      }
      // Item 10: cancelled (even before it arrived): never starts. A resend uses a new message id.
      if (begun.status === 'cancelled') {
        deps.log?.('ai_cancelled_before_start', {});
        return done(err(409, 'request_cancelled', t('aiServer.error.requestCancelled'), { reason: 'cancelled' }));
      }
      if (begun.status !== 'started') {
        deps.log?.('ai_in_progress', {});
        return done(err(409, 'in_progress', t('aiServer.error.inProgress'), { reason: 'in_progress' }));
      }
      attempt = begun.attempt;
    } else await deps.db.checkAndCountUsage(uid, limit);
  } catch (e) {
    if ((e as { code?: string })?.code === 'PT429') {
      const usage = await usageFor(deps, uid).catch(() => null);
      // The database's message is English prose: Icelandic gets the authored copy (never the raw PT429 text).
      const message = setting === 'is' ? t('aiServer.error.dailyLimit') : (e as Error).message || t('aiServer.error.dailyLimit');
      return done(err(429, 'rate_limited', message, { reason: 'rate_limited', usage }));
    }
    throw e;
  }

  // Failure accounting (1.0.3): a request that fails gives its daily allowance back, and tokens from provider rounds that
  // did complete are booked as FAILED usage — never as a successful exchange. The database decides: the call is a no-op
  // unless this attempt still owns the running request (so a lost response after the answer was stored never refunds).
  const tally = { inputTokens: 0, outputTokens: 0, unknown: false };
  let settled = false;
  const attemptUsage = () => ({
    inputTokens: tally.inputTokens,
    outputTokens: tally.outputTokens,
    costUsd: estimateCostUsd(tally, deps.env('AI_PRICE_INPUT_PER_MTOK'), deps.env('AI_PRICE_OUTPUT_PER_MTOK')),
    ...(tally.unknown ? { unknown: true } : {}),
  });
  const fail = async () => {
    if (settled) return;
    settled = true;
    try {
      if (attempt) await deps.db.failRequest?.(uid, id, attempt, attemptUsage());
    } catch (e) {
      deps.log?.('ai_fail_request_error', { code: (e as { code?: string })?.code ?? null });
    }
  };
  // Item 10: the user stopped the reply. The worker acknowledges (cancelled, one refund, completed-round tokens booked);
  // nothing is published. Never treated as a provider failure or a timeout.
  const cancelled = async (): Promise<CoachResult> => {
    if (!settled) {
      settled = true;
      try {
        if (attempt) await deps.db.settleCancelled?.(uid, id, attempt, attemptUsage());
      } catch (e) {
        deps.log?.('ai_settle_cancel_error', { code: (e as { code?: string })?.code ?? null });
      }
    }
    deps.log?.('ai_cancelled', { input_tokens: tally.inputTokens, output_tokens: tally.outputTokens });
    return err(409, 'request_cancelled', t('aiServer.error.requestCancelled'), { reason: 'cancelled', usage: await usageFor(deps, uid).catch(() => null) });
  };
  const recordOnce = async <T,>(record: () => Promise<T>): Promise<T> => {
    const r = await record();
    settled = true; // stored: from here on the exchange counts as successful
    return r;
  };
  const run = async (hooks: { onPhase?: (p: CoachPhase) => void } = {}): Promise<CoachResult> => {
    // Cooperative cancellation: a bounded poll of this request's state aborts the attempt-owned signal.
    const cancelCtl = new AbortController();
    const poll = attempt && deps.db.requestState ? startCancelPoll(deps, uid, id, cancelCtl, intEnv(deps, 'AI_CANCEL_POLL_MS', 1500, 200, 10_000)) : null;
    const phaseDeps: CoachDeps = {
      ...deps,
      onPhase: (p) => {
        try {
          hooks.onPhase?.(p);
          deps.onPhase?.(p);
        } catch {
          // A progress writer must never affect the answer (stream errors are the transport's business).
        }
      },
    };
    try {
      phaseDeps.onPhase!('preparing');
      return await answer({ deps: phaseDeps, uid, id, text, mode, unsynced, workout, prov, settings, tally, fail, cancelled, recordOnce, setting, signal: cancelCtl.signal });
    } catch (e) {
      if (e instanceof AiCancelledError || isCancelledDbError(e)) return await cancelled();
      await fail();
      throw e;
    } finally {
      poll?.stop();
    }
  };
  return { kind: 'started', requestId: id, run };
}

const isCancelledDbError = (e: unknown) => (e as { code?: string })?.code === 'PT409' && (e as { hint?: string })?.hint === 'cancelled';

/** Bounded polling of the request row (item 10): aborts `ctl` once a cancel is requested. Stops when the answer ends. */
function startCancelPoll(deps: CoachDeps, uid: string, id: string, ctl: AbortController, everyMs: number) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let checks = 0;
  const maxChecks = Math.ceil((TOTAL_BUDGET_MS + 30_000) / everyMs);
  const tick = async () => {
    if (stopped) return;
    checks += 1;
    try {
      const st = await deps.db.requestState!(uid, id);
      if (st === 'cancel_requested' || st === 'cancelled') {
        ctl.abort();
        return;
      }
    } catch {
      // A failed check is not a cancel; the next one (or the final check before saving) decides.
    }
    if (!stopped && checks < maxChecks) timer = setTimeout(tick, everyMs);
  };
  timer = setTimeout(tick, everyMs);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/** Everything send() decided before the provider is called, plus the failure accounting hooks (1.0.3). */
interface Answering {
  deps: CoachDeps;
  uid: string;
  id: string;
  text: string;
  mode: 'chat' | 'checkin_review';
  unsynced: number;
  workout: WorkoutContext | null;
  prov: NonNullable<ReturnType<typeof resolveProvider>>;
  settings: AiSettingsRow;
  tally: { inputTokens: number; outputTokens: number; unknown: boolean };
  fail: () => Promise<void>;
  /** Settle as cancelled (item 10) and build the response. */
  cancelled: () => Promise<CoachResult>;
  recordOnce: <T>(record: () => Promise<T>) => Promise<T>;
  /** The request's validated app language (Settings.language), or null when it sent none. */
  setting: Lang | null;
  /** Aborted when the user cancels (attempt-owned; item 10). */
  signal: AbortSignal;
}

async function answer(a: Answering): Promise<CoachResult> {
  const { deps, uid, id, text, mode, unsynced, workout, prov, settings, tally, fail, cancelled, recordOnce, setting, signal } = a;
  const phase = (p: CoachPhase) => deps.onPhase?.(p);
  /** Bounded cancellation check at the points where work would otherwise continue. */
  const stopRequested = async () => {
    if (signal.aborted) return true;
    if (!deps.db.requestState) return false;
    try {
      const st = await deps.db.requestState(uid, id);
      return st === 'cancel_requested' || st === 'cancelled';
    } catch {
      return false;
    }
  };
  const now = deps.now?.() ?? new Date();
  const started = Date.now();
  // Hidden product areas (coach marketplace, social feed) stay out of the app guide and its links.
  const features = guideFeaturesFromEnv(deps.env);
  // Structured Outputs (item 10) only where the configured provider/model/endpoint supports it; else the text path.
  const output: OutputFormat = outputFormatFor(prov, deps.env);
  const ctx = await buildContext({
    db: deps.db, uid, settings, text, mode, now, unsynced, features, workout, output: output === 'json_schema' ? 'structured' : 'text', onPhase: phase,
  });
  const model = prov.model;
  const maxTokens = intEnv(deps, 'AI_MAX_OUTPUT_TOKENS', 1200, 64, 8192);
  const state: ToolState = { proposal: null, proposalAttempts: 0, weekPlan: null, weekAttempts: 0, mealPlan: null, mealPlanAttempts: 0, recipes: null, sessionAdjustment: null };
  // The user's own words for this request — for a short follow-up ("ok, try now") also the original request — so tools
  // and the meal-plan fallback keep the user's restrictions even when the model's tool input drops them.
  const requestText = ctx.followUp && ctx.openRequest ? `${ctx.openRequest.text}\n${text}` : text;
  // Reply language (replyLanguage.ts): an explicit request in this message, else its clear language, else the app
  // language the request carries, else earlier messages (newest first), else English. Tools write user-facing text in it.
  const earlier = ctx.messages.filter((m) => m.role === 'user' && typeof m.content === 'string').map((m) => m.content as string).reverse();
  const history = [ctx.openRequest?.text, ...earlier];
  const toolLang = resolveReplyLang({ text, history, setting });
  // Tell the model which language to answer in when the app sent its language or the user asked for one; requests from
  // older apps keep the prompt as it was.
  const langSource = replyLangSource({ text, setting });
  const langControl = setting || langSource === 'asked' || langSource === 'refused' ? replyLanguageLine(toolLang, langSource) : null;
  // A meal-plan / recipe request the user has to settle first ("Vegan matseðill með kjúklingi", "2,5 máltíðir"): no plan or
  // recipe cards are built for it (tools and the fallback refuse), and the model is told to ask instead.
  const resumedPlan = ctx.followUp && ctx.openRequest?.intent === 'meal_plan';
  const kind = classifyRequest(text);
  const clarify = resumedPlan || kind === 'meal_plan' || kind === 'recipes' ? requestClarification(requestText) : null;
  // Both are server-derived controls: composed with the others, before the app guide and the data (prompts/index.ts).
  const system = ctx.compose([langControl ?? '', clarify ? `Before any meal plan or recipes: ${clarificationNote(clarify)}` : '']);
  const conversation: ApiMessage[] = [...ctx.messages];
  let usage = { inputTokens: 0, outputTokens: 0 };
  let reply = '';
  let usedModel = model;
  let rounds = 0;
  // How the final round ended (Structured Outputs: refusal / truncation are explicit, never parsed as an answer).
  let finalStop: string | null = null;
  let finalRefusal: string | null = null;
  const deadline = Date.now() + TOTAL_BUDGET_MS;

  try {
    for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
      if (await stopRequested()) return await cancelled();
      rounds = round;
      const last = round === MAX_TOOL_ROUNDS;
      phase('writing');
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
          signal,
        },
        // Last round: tools stay declared (the history contains tool blocks) but may not be called.
        // The schema is sent on every round: the model may finish (answer) in any of them.
        {
          system, messages: conversation, tools: TOOL_DEFS, tool_choice: { type: last ? 'none' : 'auto' },
          ...(output === 'json_schema' ? { responseFormat: { name: REPLY_SCHEMA_NAME, schema: REPLY_SCHEMA as unknown as Record<string, unknown> } } : {}),
        },
      );
      // Usage of every completed round is counted BEFORE anything is parsed, so an invalid reply still books it.
      usage = addUsage(usage, res.usage);
      tally.inputTokens = usage.inputTokens;
      tally.outputTokens = usage.outputTokens;
      // Missing provider usage is unknown, never zero (booked as such if this request fails or is cancelled).
      if (!res.usage || (res.usage.input_tokens == null && res.usage.output_tokens == null)) tally.unknown = true;
      if (typeof res.model === 'string') usedModel = res.model.slice(0, 100);
      const toolUses = res.content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
      if (res.stop_reason !== 'tool_use' || toolUses.length === 0 || last) {
        reply = textOf(res.content);
        finalStop = res.stop_reason ?? null;
        finalRefusal = typeof res.refusal === 'string' ? res.refusal : null;
        if (output === 'text' && res.stop_reason === 'max_tokens' && reply) reply += ' …';
        break;
      }
      conversation.push({ role: 'assistant', content: res.content });
      const results: ContentBlock[] = [];
      for (const tu of toolUses.slice(0, 4)) {
        if (tu.name === 'find_recipes') phase('recipes');
        else if (tu.name.startsWith('propose_')) phase('planning');
        const out = await runTool(tu.name, tu.input, {
          db: deps.db, facts: ctx.facts, catalog: ctx.catalog, state, week: ctx.week, trainingShared: ctx.trainingShared, messageId: id,
          today: ctx.today, nutrition: ctx.nutrition, account: ctx.account, requestText, userText: text, workout: ctx.workout, lang: toolLang,
        });
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: out.content, ...(out.isError ? { is_error: true } : {}) });
      }
      for (const tu of toolUses.slice(4)) results.push({ type: 'tool_result', tool_use_id: tu.id, content: '{"error":"Too many tool calls."}', is_error: true });
      conversation.push({ role: 'user', content: results });
    }
  } catch (e) {
    if (e instanceof AiCancelledError) return await cancelled();
    if (e instanceof AiUnavailableError) {
      deps.log?.('ai_provider_error', { provider: prov.provider, kind: e.kind, status: e.status ?? null, reason: e.reason, rounds });
      await fail();
      // i18n: no approved Icelandic copy for "unavailable right now" (provider_down) — it stays English (code is stable).
      const message = e.reason === 'not_configured' && toolLang === 'is' ? sharedT('is').t('aiServer.error.notConfigured') : e.message;
      return err(503, 'ai_unavailable', message, { reason: e.reason });
    }
    throw e;
  }

  phase('checking');
  // Structured Outputs: the final text must be exactly the {answer, why} envelope. A refusal, a truncated or malformed
  // envelope is never shown (no raw JSON): the reply falls back to a valid server action's own summary below, or the
  // request fails as invalid_reply. No extra "repair" generation.
  let envelopeFailure: string | null = null;
  let modelWhy: string | null = null;
  if (output === 'json_schema') {
    const env = parseEnvelope(reply, finalStop, finalRefusal);
    if (env.ok) {
      reply = env.answer;
      modelWhy = env.why;
    } else {
      envelopeFailure = env.reason;
      reply = '';
      deps.log?.('ai_reply_invalid', { reason: env.reason, rounds });
    }
  }
  // Reasoning goes to a separate, collapsed "Why this?" field; boilerplate the style rules forbid is trimmed.
  const split = splitWhy(reply);
  let why = (modelWhy ?? split.why) ? tidyReply((modelWhy ?? split.why)!).slice(0, 1500) || null : null;
  reply = tidyReply(split.answer);
  // Server-written text follows the same order; without an app language the model's own reply is the last hint.
  const lang = resolveReplyLang({ text, history: [...history, reply], setting });
  const tr = sharedT(lang);
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
  const resumed = resumedPlan;
  const wantsPlan = asksForMealPlan(text) || resumed;
  // A request that needs the user's answer first gets no plan at all (the model was told to ask; see `clarify`).
  if (wantsPlan && clarify) {
    state.mealPlan = null;
    state.recipes = null;
    deps.log?.('ai_meal_plan_clarify', { kind: clarify.kind });
  } else if (wantsPlan && !state.mealPlan && !state.weekPlan && !mealPlanBlocker(ctx.nutrition)) {
    phase('recipes');
    const [recipes, ingredients] = await Promise.all([deps.db.getRecipes(), deps.db.getIngredients()]);
    phase('planning');
    const built = buildMealPlanAction(mealPlanIntentFromText(requestText), { facts: ctx.facts, account: ctx.account, today: ctx.today, nutrition: ctx.nutrition, messageId: id, recipes, ingredients, requestText, lang });
    if (built.action) {
      state.mealPlan = built.action;
      replaced = 'meal_plan_fallback';
    } else if (built.clarify) {
      // e.g. "four days" when only three are left this week: ask, never a shorter or different plan.
      deps.log?.('ai_meal_plan_clarify', { kind: built.clarify.kind });
    } else if (built.errors.length) {
      fallbackFailure = built.errors[0];
      deps.log?.('ai_reply_replaced', { reason: 'meal_plan_fallback_failed' });
    }
  }

  // "Short on time" / "Equipment busy" from the workout screen must end in a real, checked change to today's workout: if
  // the model answered without propose_session_adjustment, the server builds it from the request (main lifts kept /
  // the first suitable alternative). If nothing valid exists, the model's text stands on its own.
  const live = ctx.workout;
  if (live && live.status === 'active' && !state.sessionAdjustment && (live.intent === 'shorten' || live.intent === 'swap')) {
    const focus = live.exercises.find((e) => e.id === live.focusId);
    const from = focus ? ctx.catalog.get(focus.exerciseId) : undefined;
    const tries: Record<string, unknown>[] =
      live.intent === 'shorten'
        ? [{ change: 'shorten', minutes: live.minutesLeft }]
        : from && focus ? alternativesFor(from, ctx.catalog, ctx.facts).slice(0, 8).map((c) => ({ change: 'swap', session_exercise_id: focus.id, to_exercise_id: c.id })) : [];
    if (tries.length) phase('planning');
    for (const input of tries) {
      const built = buildSessionAdjustment(input, { catalog: ctx.catalog, facts: ctx.facts, messageId: id, workout: live, trainingShared: ctx.trainingShared, lang });
      if (built.action) {
        state.sessionAdjustment = built.action;
        deps.log?.('ai_session_adjustment_fallback', { change: built.action.change });
        break;
      }
    }
  }

  // One structured action per reply: today's workout change, else a this-week schedule change, else a meal plan, else
  // recipe cards.
  const weekPlan = state.sessionAdjustment ? null : state.weekPlan ?? null;
  const sessionAdjustment = state.sessionAdjustment ?? null;
  const action: AiAction | null = sessionAdjustment ?? weekPlan ?? state.mealPlan ?? state.recipes ?? null;
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
  if (fallbackFailure) reply = tr.t('aiServer.reply.mealPlanFailed', { reason: fallbackFailure });
  if (replaced) {
    reply =
      weekPlan ? summarizeWeekPlan(weekPlan, ctx.today, ctx.facts.weekStart, lang)
        : state.mealPlan ? summarizeMealPlan(state.mealPlan, ctx.today, ctx.facts.weekStart, lang)
          : summarizeProposal(proposalInfo!, lang);
    // Keep the acknowledgement the prompt asked for when sharing just changed.
    if (ctx.sharingAdded.length) reply = `${thanksLine(ctx.sharingAdded, lang)} ${reply}`;
    deps.log?.('ai_reply_replaced', { reason: replaced });
  }

  // A malformed envelope with no valid server action: nothing checked to show. Settle as failed (refund, failed usage).
  if (envelopeFailure && !action && !(p && p.validationErrors.length === 0) && !fallbackFailure) {
    await fail();
    return err(502, 'invalid_reply', tr.t('aiServer.error.invalidReply'), { reason: 'invalid_reply' });
  }

  // In-app links: ≤ 2 screen links and ≤ 3 recipe links whose path is in the app guide (param routes only with ids we
  // know); the rest are stripped, lead-in lines removed, and the kept links moved to the end.
  const known = { ...ctx.known };
  if (/\[\[\s*open\s*:\s*\/nutrition\/recipes\//i.test(reply)) known.recipe = new Set((await deps.db.getRecipes()).map((r) => r.id));
  const links = validateOpenLinks(reply, known, features);
  reply = links.text;
  if (!reply) {
    reply = sessionAdjustment
      ? describeSessionAdjustment(sessionAdjustment, lang)
      : weekPlan
      ? summarizeWeekPlan(weekPlan, ctx.today, ctx.facts.weekStart, lang)
      : state.mealPlan
        ? summarizeMealPlan(state.mealPlan, ctx.today, ctx.facts.weekStart, lang)
        : proposalInfo
          ? summarizeProposal(proposalInfo, lang)
          : state.recipes
            ? summarizeRecipes(state.recipes, lang)
            : tr.t('aiServer.reply.empty');
  }
  reply = reply.slice(0, MAX_REPLY_CHARS);

  // Before publication (item 10): the user may have stopped the reply, or narrowed sharing / revoked consent while it was
  // being written. Either way the buffered reply is discarded and never stored.
  if (await stopRequested()) return await cancelled();
  const fresh = await deps.db.getSettings(uid);
  if (!sharingStillAllows(settings, fresh, prov.provider)) {
    deps.log?.('ai_sharing_changed', {});
    await fail();
    return err(409, 'sharing_changed', tr.t('aiServer.error.sharingChanged'), { reason: 'sharing_changed' });
  }
  phase('saving');
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
  // A database without the 2026-11-28 migration drops the new session_adjustment kind; still return it for this reply
  // (it then can't be shown again after a reload, which the app handles: the change is only for today anyway).
  if (!recorded.duplicate && sessionAdjustment && !storedReply.action) storedReply.action = sessionAdjustment;
  return {
    status: 200,
    body: {
      reply: storedReply, proposal: (recorded.proposal ?? null) as ProposalJson | null, duplicate: Boolean(recorded.duplicate),
      // Authoritative usage after this exchange (item 10): the app refreshes it instead of counting replies itself.
      usage: await usageFor(deps, uid).catch(() => null),
    },
  };
}

/**
 * Still allowed to publish (item 10)? On, not paused, consent for this provider, and every category this reply was built
 * from still shared. Widening sharing is fine; any narrowing, a pause or a provider/consent change is not. A database
 * read that returns nothing counts as changed.
 */
export function sharingStillAllows(used: AiSettingsRow, fresh: AiSettingsRow | null, provider: ProviderId): boolean {
  if (!fresh || !fresh.enabled || fresh.paused || consentedProvider(fresh) !== provider) return false;
  return (['profile', 'training', 'measurements', 'nutrition'] as const).every((k) => !used.scopes[k] || fresh.scopes[k]);
}

