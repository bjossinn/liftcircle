/**
 * AI provider client (pure: fetch, sleep and clock are injected). Two providers, one internal format:
 *  - anthropic: POST {baseUrl}/v1/messages with x-api-key + anthropic-version (the internal format IS this wire format)
 *  - openai:    POST {baseUrl}/v1/chat/completions with a Bearer key; requests/responses are translated in ./openai.ts
 * The rest of the AI coach (context, tools, validation, storage) only ever sees the internal format.
 *
 * Each attempt has its own AbortController
 * timeout; transient failures (429, 5xx incl. 529 overloaded, network errors) are retried at most
 * `maxRetries` times with exponential backoff that honours `retry-after` (capped, and never beyond the
 * overall deadline). Other 4xx responses are never retried. Every failure surfaces as AiUnavailableError
 * ({ code: 'ai_unavailable', reason }) — callers never see provider bodies, and nothing here logs content.
 */
import type { ApiMessage, ApiResponse, FetchLike } from './types.ts';
// @ts-ignore — Deno needs the .ts extension; the app tsconfig resolves it without
import { fromOpenAiResponse, isOpenAiQuotaError, toOpenAiRequest } from './openai.ts';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_API_VERSION = '2023-06-01';
export const DEFAULT_OPENAI_MODEL = 'gpt-5-mini';

export type ProviderId = 'anthropic' | 'openai';
export const PROVIDER_NAMES: Record<ProviderId, string> = { anthropic: 'Anthropic', openai: 'OpenAI' };

export interface ResolvedProvider {
  provider: ProviderId;
  apiKey: string;
  model: string;
  baseUrl?: string;
  apiVersion?: string;
  /** OpenAI reasoning models only; undefined = don't send the parameter. */
  reasoningEffort?: string;
  /** Extra completion tokens allowed for hidden reasoning (OpenAI reasoning models). */
  reasoningAllowance?: number;
}

/**
 * Which provider the server is configured for, from env:
 *   AI_PROVIDER=openai|anthropic picks explicitly; otherwise OpenAI when only OPENAI_API_KEY is set, else Anthropic.
 * null when the chosen provider has no key (→ truthful "not configured").
 */
export function resolveProvider(env: (name: string) => string | undefined): ResolvedProvider | null {
  const get = (k: string) => env(k)?.trim() || undefined;
  const explicit = get('AI_PROVIDER')?.toLowerCase();
  const provider: ProviderId =
    explicit === 'openai' || explicit === 'anthropic' ? explicit : get('OPENAI_API_KEY') && !get('ANTHROPIC_API_KEY') ? 'openai' : 'anthropic';
  if (provider === 'openai') {
    const apiKey = get('OPENAI_API_KEY');
    if (!apiKey) return null;
    const model = get('OPENAI_MODEL') ?? DEFAULT_OPENAI_MODEL;
    const reasoning = /^(gpt-5|o\d)/i.test(model);
    const effortEnv = get('OPENAI_REASONING_EFFORT')?.toLowerCase();
    const reasoningEffort = effortEnv === 'off' ? undefined : (effortEnv ?? (reasoning ? 'low' : undefined));
    const allowance = Number(get('OPENAI_REASONING_TOKEN_ALLOWANCE'));
    return {
      provider,
      apiKey,
      model,
      baseUrl: get('OPENAI_BASE_URL'),
      reasoningEffort,
      reasoningAllowance: reasoningEffort ? (Number.isFinite(allowance) && allowance >= 0 ? Math.min(16_000, Math.floor(allowance)) : 2000) : 0,
    };
  }
  const apiKey = get('ANTHROPIC_API_KEY');
  if (!apiKey) return null;
  return { provider, apiKey, model: get('ANTHROPIC_MODEL') ?? DEFAULT_MODEL, baseUrl: get('ANTHROPIC_BASE_URL'), apiVersion: get('ANTHROPIC_VERSION') };
}

export class AiUnavailableError extends Error {
  readonly code = 'ai_unavailable';
  constructor(
    readonly reason: 'provider_down' | 'not_configured',
    /** Internal classification for logs/tests (never shown verbatim to users). */
    readonly kind: 'timeout' | 'http' | 'network' | 'bad_response' | 'deadline' | 'quota',
    readonly status?: number,
  ) {
    super(reason === 'not_configured' ? 'The AI coach is not configured on the server.' : 'The AI coach is unavailable right now.');
    this.name = 'AiUnavailableError';
  }
}

export interface ProviderConfig {
  /** Default 'anthropic'. */
  provider?: ProviderId;
  reasoningEffort?: string;
  reasoningAllowance?: number;
  apiKey: string;
  model: string;
  apiVersion?: string;
  baseUrl?: string;
  maxTokens: number;
  timeoutMs?: number; // per attempt (default 45 s)
  maxRetries?: number; // default 2
  fetch: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  /** Absolute epoch-ms deadline for the whole call incl. retries. */
  deadline?: number;
}

export interface MessagesRequest {
  system: string;
  messages: ApiMessage[];
  tools?: readonly unknown[];
  tool_choice?: { type: 'auto' | 'none' | 'any' };
}

const RETRYABLE = (s: number) => s === 429 || s === 408 || s >= 500; // 500/502/503/504/529
const MAX_RETRY_AFTER_MS = 20_000;

export function parseRetryAfter(v: string | null, now: number): number | null {
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

export async function createMessage(cfg: ProviderConfig, req: MessagesRequest): Promise<ApiResponse> {
  const now = cfg.now ?? Date.now;
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = cfg.random ?? Math.random;
  const timeoutMs = cfg.timeoutMs ?? 45_000;
  const maxRetries = Math.max(0, Math.min(5, cfg.maxRetries ?? 2));
  const deadline = cfg.deadline ?? now() + timeoutMs * (maxRetries + 1) + 10_000;
  const openai = cfg.provider === 'openai';
  const body = JSON.stringify(
    openai
      ? toOpenAiRequest(req, { model: cfg.model, maxTokens: cfg.maxTokens + (cfg.reasoningAllowance ?? 0), reasoningEffort: cfg.reasoningEffort })
      : {
          model: cfg.model,
          max_tokens: cfg.maxTokens,
          system: req.system,
          messages: req.messages,
          ...(req.tools?.length ? { tools: req.tools } : {}),
          ...(req.tools?.length && req.tool_choice ? { tool_choice: req.tool_choice } : {}),
        },
  );
  const headers: Record<string, string> = openai
    ? { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' }
    : { 'x-api-key': cfg.apiKey, 'anthropic-version': cfg.apiVersion || DEFAULT_API_VERSION, 'content-type': 'application/json' };
  const url = openai
    ? `${(cfg.baseUrl ?? 'https://api.openai.com').replace(/\/+$/, '')}/v1/chat/completions`
    : `${(cfg.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '')}/v1/messages`;

  let last: AiUnavailableError = new AiUnavailableError('provider_down', 'deadline');
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const remaining = deadline - now();
    if (remaining <= 1000) throw last.kind === 'deadline' ? last : new AiUnavailableError('provider_down', last.kind, last.status);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.min(timeoutMs, remaining));
    let retryAfterMs: number | null = null;
    try {
      const res = await cfg.fetch(url, { method: 'POST', headers, body, signal: ctl.signal });
      if (res.ok) {
        let data: unknown;
        try {
          data = await res.json();
        } catch {
          throw new AiUnavailableError('provider_down', 'bad_response', res.status);
        }
        const d = openai ? fromOpenAiResponse(data) : (data as ApiResponse);
        if (!d || !Array.isArray(d.content)) throw new AiUnavailableError('provider_down', 'bad_response', res.status);
        return d;
      }
      // Drain the body without exposing it (only an OpenAI quota code is inspected, never logged).
      const errText = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) throw new AiUnavailableError('not_configured', 'http', res.status);
      // OpenAI: out of credits / billing limit reached is a 429 that retrying can't fix.
      if (openai && res.status === 429 && isOpenAiQuotaError(errText)) throw new AiUnavailableError('provider_down', 'quota', res.status);
      if (!RETRYABLE(res.status)) throw new AiUnavailableError('provider_down', 'http', res.status);
      last = new AiUnavailableError('provider_down', 'http', res.status);
      retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), now());
    } catch (e) {
      if (e instanceof AiUnavailableError) {
        if (e !== last) throw e; // non-retryable classification
      } else if (ctl.signal.aborted) {
        // Per-attempt timeout: don't burn the remaining budget on another long wait.
        throw new AiUnavailableError('provider_down', 'timeout');
      } else {
        last = new AiUnavailableError('provider_down', 'network'); // fetch threw (DNS, reset, …) → retry
      }
    } finally {
      clearTimeout(timer);
    }
    if (attempt === maxRetries) break;
    const backoff = Math.round(800 * 2 ** attempt * (0.75 + random() * 0.5));
    const wait = Math.min(MAX_RETRY_AFTER_MS, Math.max(backoff, retryAfterMs ?? 0));
    if (now() + wait + 2000 > deadline) break;
    await sleep(wait);
  }
  throw last;
}

/* ------------------------------------------------------------------ usage & cost */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
}

export function addUsage(t: UsageTotals, u: ApiResponse['usage']): UsageTotals {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  return {
    inputTokens: t.inputTokens + n(u?.input_tokens) + n(u?.cache_creation_input_tokens) + n(u?.cache_read_input_tokens),
    outputTokens: t.outputTokens + n(u?.output_tokens),
  };
}

/** USD estimate from env prices per million tokens; null when either price is not configured. */
export function estimateCostUsd(t: UsageTotals, priceInPerMTok: string | undefined, priceOutPerMTok: string | undefined): number | null {
  const pin = priceInPerMTok != null && priceInPerMTok.trim() !== '' ? Number(priceInPerMTok) : NaN;
  const pout = priceOutPerMTok != null && priceOutPerMTok.trim() !== '' ? Number(priceOutPerMTok) : NaN;
  if (!Number.isFinite(pin) || !Number.isFinite(pout) || pin < 0 || pout < 0) return null;
  return Math.round(((t.inputTokens / 1e6) * pin + (t.outputTokens / 1e6) * pout) * 1e6) / 1e6;
}
