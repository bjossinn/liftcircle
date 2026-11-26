/**
 * Test helper (item 10): makes a canned fake-provider response behave like a model that follows Structured Outputs.
 * Only when the request asked for the reply schema (Anthropic output_config.format / OpenAI response_format) and the
 * response is a final text turn, the fake's prose becomes the {answer, why} envelope (an optional "[[why]]" part goes
 * into `why`). Tool turns, refusals, truncations and responses that are already JSON are passed through unchanged, so
 * tests can still feed malformed envelopes on purpose.
 */
import { splitWhy } from '../../../supabase/functions/_shared/ai/reply';

const isJson = (t: string) => {
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
};
const envelope = (text: string) => {
  const s = splitWhy(text);
  return JSON.stringify({ answer: s.answer, why: s.why });
};

export function followSchema<T>(rawRequest: unknown, res: T): T {
  let req: Record<string, unknown>;
  try {
    req = JSON.parse(String(rawRequest ?? '')) as Record<string, unknown>;
  } catch {
    return res;
  }
  if (!res || typeof res !== 'object') return res;
  const r = res as Record<string, unknown>;
  if ((req.output_config as { format?: unknown } | undefined)?.format && Array.isArray(r.content)) {
    const blocks = r.content as { type: string; text?: string }[];
    if (r.stop_reason === 'tool_use' || r.stop_reason === 'refusal' || r.stop_reason === 'max_tokens' || blocks.some((b) => b.type === 'tool_use')) return res;
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
    if (isJson(text.trim())) return res;
    return { ...r, content: [{ type: 'text', text: envelope(text) }] } as T;
  }
  if (req.response_format && Array.isArray(r.choices)) {
    const c = (r.choices as { finish_reason?: string; message?: { content?: unknown; tool_calls?: unknown[]; refusal?: unknown } }[])[0];
    const m = c?.message;
    if (!m || (m.tool_calls?.length ?? 0) > 0 || c.finish_reason === 'length' || m.refusal || typeof m.content !== 'string' || isJson(m.content.trim())) return res;
    return { ...r, choices: [{ ...c, message: { ...m, content: envelope(m.content) } }, ...(r.choices as unknown[]).slice(1)] } as T;
  }
  return res;
}
