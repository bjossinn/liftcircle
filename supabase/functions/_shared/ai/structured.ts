/**
 * Structured Outputs for the final conversational envelope (roadmap item 10). Pure.
 *
 *   {"answer": string, "why": string | null}   (both required, nothing else)
 *
 * `why` is a short user-facing explanation ("Why this?"), never hidden reasoning. Actions, proposals, grounding,
 * permissions and safety decisions stay server-owned: they are never part of this schema.
 *
 * Capability is explicit configuration, never guessed from a custom endpoint:
 *   AI_STRUCTURED_OUTPUT=auto (default) — only the provider's official endpoint (no *_BASE_URL) and a model known to
 *                                           support it;
 *                        on             — the configured endpoint is declared to support it (e.g. a compatible proxy);
 *                        off            — never.
 * Anything unsupported uses the existing text reply + splitWhy() path from the first round. Nothing here switches
 * provider or model, so consent is unaffected.
 */
import type { ResolvedProvider } from './provider.ts';

export const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    why: { type: ['string', 'null'] },
  },
  required: ['answer', 'why'],
  additionalProperties: false,
} as const;
export const REPLY_SCHEMA_NAME = 'coach_reply';

export type OutputFormat = 'json_schema' | 'text';

/** OpenAI models with response_format json_schema (Chat Completions). */
const OPENAI_STRUCTURED = /^(gpt-4o(?!-2024-05-13)|gpt-4o-mini|gpt-4\.1|gpt-5|o1(?!-mini|-preview)|o3|o4)/i;
/** Anthropic models with output_config.format (no beta header). */
const ANTHROPIC_STRUCTURED = /^claude-(fable-5|mythos-5|opus-5|sonnet-5|haiku-5|opus-4-[158]|haiku-4-5)/i;

export function modelSupportsStructured(provider: ResolvedProvider['provider'], model: string): boolean {
  return provider === 'openai' ? OPENAI_STRUCTURED.test(model) : ANTHROPIC_STRUCTURED.test(model);
}

/** Which output format this server uses for the configured provider/model/endpoint. */
export function outputFormatFor(prov: Pick<ResolvedProvider, 'provider' | 'model' | 'baseUrl'>, env: (name: string) => string | undefined): OutputFormat {
  const mode = (env('AI_STRUCTURED_OUTPUT') ?? 'auto').trim().toLowerCase();
  if (mode === 'off' || mode === 'false' || mode === '0') return 'text';
  if (mode === 'on' || mode === 'true' || mode === '1') return 'json_schema';
  if (prov.baseUrl && prov.baseUrl.trim()) return 'text'; // custom endpoint: not assumed to support it
  return modelSupportsStructured(prov.provider, prov.model) ? 'json_schema' : 'text';
}

export type Envelope = { ok: true; answer: string; why: string | null } | { ok: false; reason: 'refusal' | 'truncated' | 'invalid_json' | 'invalid_shape' };

/**
 * The final round's text as the envelope. Refusal and truncation are reported as such (never parsed as JSON); anything
 * that isn't exactly {answer: string, why: string|null} is invalid. Raw JSON is never shown to the user. No text at all,
 * or an empty answer, is a valid empty reply: the existing server fallbacks (action summary / "couldn't reply") apply.
 */
export function parseEnvelope(text: string, stopReason: string | null | undefined, refusal?: string | null): Envelope {
  if (stopReason === 'refusal' || (refusal && refusal.trim())) return { ok: false, reason: 'refusal' };
  if (stopReason === 'max_tokens') return { ok: false, reason: 'truncated' };
  const t = String(text ?? '').trim();
  if (!t) return { ok: true, answer: '', why: null };
  let v: unknown;
  try {
    v = JSON.parse(t);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, reason: 'invalid_shape' };
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== 2 || !keys.includes('answer') || !keys.includes('why')) return { ok: false, reason: 'invalid_shape' };
  if (typeof o.answer !== 'string') return { ok: false, reason: 'invalid_shape' };
  if (o.why !== null && typeof o.why !== 'string') return { ok: false, reason: 'invalid_shape' };
  return { ok: true, answer: o.answer, why: typeof o.why === 'string' && o.why.trim() ? o.why : null };
}
