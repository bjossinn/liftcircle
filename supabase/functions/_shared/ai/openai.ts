/**
 * OpenAI Chat Completions adapter. Pure translation between the AI coach's internal message format
 * (Anthropic-style content blocks: text / tool_use / tool_result) and the OpenAI wire format:
 *
 *   system prompt               → { role: 'system' }
 *   assistant text + tool_use   → { role: 'assistant', content, tool_calls: [{ id, type: 'function', function: { name, arguments } }] }
 *   user tool_result blocks     → one { role: 'tool', tool_call_id, content } per result (then any user text)
 *   tools { input_schema }      → { type: 'function', function: { name, description, parameters } }
 *   tool_choice none/auto/any   → 'none' / 'auto' / 'required'
 *
 * Response: choices[0].message → text + tool_use blocks; finish_reason tool_calls/length/stop →
 * stop_reason tool_use/max_tokens/end_turn; usage prompt/completion tokens → input/output tokens
 * (completion tokens include hidden reasoning tokens, which OpenAI bills as output).
 */
import type { ApiMessage, ApiResponse, ContentBlock } from './types.ts';

interface InternalRequest {
  system: string;
  messages: ApiMessage[];
  tools?: readonly unknown[];
  tool_choice?: { type: 'auto' | 'none' | 'any' };
}

type OaMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export function toOpenAiMessages(system: string, messages: ApiMessage[]): OaMessage[] {
  const out: OaMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content } as OaMessage);
      continue;
    }
    const texts = m.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text);
    if (m.role === 'assistant') {
      const calls = m.content
        .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
        .map((b) => ({ id: b.id, type: 'function' as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: 'assistant', content: texts.join('\n') || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? `ERROR: ${b.content}` : b.content });
        }
      }
      if (texts.length) out.push({ role: 'user', content: texts.join('\n') });
    }
  }
  return out;
}

export function toOpenAiTools(tools: readonly unknown[] | undefined) {
  return (tools ?? []).map((t) => {
    const d = t as { name: string; description?: string; input_schema?: unknown };
    return { type: 'function' as const, function: { name: d.name, description: d.description ?? '', parameters: d.input_schema ?? { type: 'object', properties: {} } } };
  });
}

export function toOpenAiRequest(req: InternalRequest, opts: { model: string; maxTokens: number; reasoningEffort?: string }) {
  const tools = toOpenAiTools(req.tools);
  const choice = req.tool_choice?.type === 'any' ? 'required' : req.tool_choice?.type;
  return {
    model: opts.model,
    messages: toOpenAiMessages(req.system, req.messages),
    max_completion_tokens: opts.maxTokens,
    ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
    ...(tools.length ? { tools, ...(choice ? { tool_choice: choice } : {}) } : {}),
  };
}

/** Translate a Chat Completions response; returns null for anything that isn't one (→ bad_response). */
export function fromOpenAiResponse(data: unknown): ApiResponse | null {
  const d = data as {
    id?: string;
    model?: string;
    choices?: { finish_reason?: string | null; message?: { content?: string | null; refusal?: string | null; tool_calls?: unknown[] } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  } | null;
  const choice = d?.choices?.[0];
  if (!choice || !choice.message || typeof choice.message !== 'object') return null;
  const msg = choice.message;
  const content: ContentBlock[] = [];
  const text = typeof msg.content === 'string' ? msg.content : typeof msg.refusal === 'string' ? msg.refusal : '';
  if (text.trim()) content.push({ type: 'text', text });
  for (const raw of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
    const c = raw as { id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } };
    if (typeof c?.id !== 'string' || typeof c.function?.name !== 'string') continue;
    let input: unknown = {};
    if (typeof c.function.arguments === 'string' && c.function.arguments.trim()) {
      try {
        input = JSON.parse(c.function.arguments);
      } catch {
        // Malformed arguments: the tool's own input validation reports the error back to the model.
        input = { _invalid_json: true };
      }
    }
    content.push({ type: 'tool_use', id: c.id, name: c.function.name, input });
  }
  const hasTools = content.some((b) => b.type === 'tool_use');
  const fr = choice.finish_reason;
  const stop_reason = hasTools && (fr === 'tool_calls' || fr === 'stop' || !fr) ? 'tool_use' : fr === 'length' ? 'max_tokens' : 'end_turn';
  return {
    id: d?.id,
    model: d?.model,
    content,
    stop_reason,
    usage: { input_tokens: d?.usage?.prompt_tokens, output_tokens: d?.usage?.completion_tokens },
  };
}

/** OpenAI's "you're out of credits / over your billing limit" 429 (retrying won't help). Never logs the body. */
export function isOpenAiQuotaError(bodyText: string): boolean {
  try {
    const e = (JSON.parse(bodyText) as { error?: { code?: unknown; type?: unknown } })?.error;
    return e?.code === 'insufficient_quota' || e?.type === 'insufficient_quota';
  } catch {
    return false;
  }
}
