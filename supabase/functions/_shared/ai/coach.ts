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
import type { AiDb, ApiMessage, ContentBlock, FetchLike, ProposalJson, StoredMessage } from './types.ts';
// @ts-ignore Deno requires the .ts extension; the app tsconfig does not enable allowImportingTsExtensions.
import { buildContext } from './context.ts';
// @ts-ignore see above
import { addUsage, AiUnavailableError, createMessage, estimateCostUsd, PROVIDER_NAMES, resolveProvider, type ProviderId } from './provider.ts';
// @ts-ignore see above
import { MAX_TOOL_ROUNDS, runTool, TOOL_DEFS, type ToolState } from './tools.ts';
// @ts-ignore see above
import { splitWhy, tidyReply, wordCount } from './reply.ts';

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

function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

async function send(deps: CoachDeps, uid: string, body: Record<string, unknown>): Promise<CoachResult> {
  // Only these three fields are read from the request.
  const id = typeof body.id === 'string' ? body.id : '';
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const mode: 'chat' | 'checkin_review' = body.mode === 'checkin_review' ? 'checkin_review' : 'chat';
  if (!UUID_RE.test(id)) return err(400, 'bad_request', 'A valid message id is required.');
  if (!text) return err(400, 'bad_request', 'Write a message first.');
  if (text.length > MAX_TEXT) return err(400, 'bad_request', `Messages can be at most ${MAX_TEXT} characters.`);

  const prov = resolveProvider(deps.env);
  if (!prov) return err(503, 'ai_unavailable', 'The AI coach is not configured on this server.', { reason: 'not_configured' });

  const settings = await deps.db.getSettings(uid);
  if (!settings?.enabled) return err(409, 'ai_disabled', 'The AI coach is turned off. Turn it on in AI coach settings.', { reason: 'disabled' });
  if (settings.paused) return err(409, 'ai_paused', 'The AI coach is paused. Resume it in AI coach settings.', { reason: 'disabled' });
  // The user agreed to send data to one specific provider; a provider switch on the server needs a fresh agreement.
  if (consentedProvider(settings) !== prov.provider)
    return err(409, 'consent_required', `The AI coach now uses ${PROVIDER_NAMES[prov.provider]}. Review what’s sent and agree again in AI coach setup.`, {
      reason: 'consent_required',
      provider: prov.provider,
    });

  const stored = await deps.db.getExchange(uid, id);
  if (stored) return { status: 200, body: { reply: stored.reply, proposal: stored.proposal ?? null, duplicate: true } };

  const limit = intEnv(deps, 'AI_DAILY_REQUEST_LIMIT', 40, 0, 10_000);
  try {
    await deps.db.checkAndCountUsage(uid, limit);
  } catch (e) {
    if ((e as { code?: string })?.code === 'PT429') {
      const usage = await usageFor(deps, uid).catch(() => null);
      return err(429, 'rate_limited', (e as Error).message || 'You’ve reached today’s AI coach limit.', { reason: 'rate_limited', usage });
    }
    throw e;
  }

  const now = deps.now?.() ?? new Date();
  const started = Date.now();
  const ctx = await buildContext({ db: deps.db, uid, settings, text, mode, now });
  const model = prov.model;
  const maxTokens = intEnv(deps, 'AI_MAX_OUTPUT_TOKENS', 1200, 64, 8192);
  const state: ToolState = { proposal: null, proposalAttempts: 0, weekPlan: null, weekAttempts: 0 };
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
        });
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: out.content, ...(out.isError ? { is_error: true } : {}) });
      }
      for (const tu of toolUses.slice(4)) results.push({ type: 'tool_result', tool_use_id: tu.id, content: '{"error":"Too many tool calls."}', is_error: true });
      conversation.push({ role: 'user', content: results });
    }
  } catch (e) {
    if (e instanceof AiUnavailableError) {
      deps.log?.('ai_provider_error', { provider: prov.provider, kind: e.kind, status: e.status ?? null, reason: e.reason, rounds });
      return err(503, 'ai_unavailable', e.message, { reason: e.reason });
    }
    throw e;
  }

  // Reasoning goes to a separate, collapsed "Why this?" field; boilerplate the style rules forbid is trimmed.
  const split = splitWhy(reply);
  const why = split.why ? tidyReply(split.why) || null : null;
  reply = tidyReply(split.answer);
  const weekPlan = state.weekPlan ?? null;
  if (!reply) {
    reply = weekPlan
      ? 'Here’s a plan for this week — you can apply it below.'
      : state.proposal
        ? 'I drafted a plan suggestion for you — see the proposal below.'
        : 'Sorry — I couldn’t put together a reply. Please try asking again.';
  }
  reply = reply.slice(0, MAX_REPLY_CHARS);
  const cost = estimateCostUsd(usage, deps.env('AI_PRICE_INPUT_PER_MTOK'), deps.env('AI_PRICE_OUTPUT_PER_MTOK'));
  const p = state.proposal;
  const recorded = await deps.db.recordExchange(uid, {
    message: { id, content: text, mode },
    reply: { content: reply, grounding: ctx.grounding, model: usedModel, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, why, action: weekPlan },
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
  });
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
  });
  // Before the 2026-10-30 migration the database doesn't store why/action; still return them for this reply.
  const storedReply = { ...(recorded.reply as StoredMessage) };
  if (!recorded.duplicate && !('why' in storedReply)) storedReply.why = why;
  if (!recorded.duplicate && !('action' in storedReply)) storedReply.action = weekPlan;
  return {
    status: 200,
    body: { reply: storedReply, proposal: (recorded.proposal ?? null) as ProposalJson | null, duplicate: Boolean(recorded.duplicate) },
  };
}

