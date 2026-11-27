/**
 * Six-part system prompt (roadmap item 10) and its composer.
 *
 * Order, always: static modules → server-derived controls → feature-filtered app guide → bounded permitted data. (The
 * filtered conversation goes in `messages`, not here.) Each section has its own budget instead of clipping the whole
 * prompt: required sections (the static rules, every control — safety, language, open request — and the data that
 * carries active restrictions) are never shortened; optional sections are clipped or dropped, lowest priority first,
 * only when the total would exceed the budget. docs/AI_PROMPT_RULES.md maps every instruction of the previous single
 * prompt to its module, the deterministic check that enforces it, and its regression test.
 */
// @ts-ignore Deno requires the .ts extension; the app tsconfig does not enable allowImportingTsExtensions.
import { IDENTITY } from './identity.ts';
// @ts-ignore see above
import { safetyModule, type CoachStyle } from './safety.ts';
// @ts-ignore see above
import { GROUNDING } from './grounding.ts';
// @ts-ignore see above
import { TRAINING } from './training.ts';
// @ts-ignore see above
import { NUTRITION } from './nutrition.ts';
// @ts-ignore see above
import { responseModule, type OutputMode } from './response.ts';

// @ts-ignore see above
export { asCoachStyle, COACH_STYLES, DEFAULT_COACH_STYLE, SAFETY, STYLE_RULES, type CoachStyle } from './safety.ts';
// @ts-ignore see above
export { OUTPUT_FORMAT, type OutputMode } from './response.ts';

/** Bump when any module's wording changes (recorded with eval results and in the content-free send log). */
export const PROMPT_VERSION = '2026-11-27.coach-voice-v1';

export type PromptModule = 'identity' | 'safety' | 'grounding' | 'training' | 'nutrition' | 'response';
/** Approximate word targets per module (the safety module includes the selected coach style). */
export const MODULE_TARGETS: Record<PromptModule, number> = { identity: 140, safety: 260, grounding: 190, training: 210, nutrition: 200, response: 400 };

export interface PromptOptions {
  style: CoachStyle;
  output: OutputMode;
}

export function promptModules(o: PromptOptions): { name: PromptModule; text: string }[] {
  return [
    { name: 'identity', text: IDENTITY },
    { name: 'safety', text: safetyModule(o.style) },
    { name: 'grounding', text: GROUNDING },
    { name: 'training', text: TRAINING },
    { name: 'nutrition', text: NUTRITION },
    { name: 'response', text: responseModule(o.output) },
  ];
}

/** The static instructions, in module order. */
export function staticInstructions(o: PromptOptions): string {
  return promptModules(o).map((m) => m.text).join('\n\n');
}

/** Bounded ceiling for the whole static instruction set (every style and output format). */
export const STATIC_WORD_CEILING = 1450;

export const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** cyrb53: a small, fast, deterministic 53-bit string hash (not cryptographic) — identifies a prompt version in results. */
export function promptHash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/* ------------------------------------------------------------------ assembly */
export type SectionKind = 'static' | 'control' | 'guide' | 'data';
const KIND_ORDER: SectionKind[] = ['static', 'control', 'guide', 'data'];

export interface PromptSection {
  kind: SectionKind;
  name: string;
  /** Section body. For data sections the body only: it is wrapped in <user_data kind="…"> after budgeting. */
  text: string;
  /** Wrap as <user_data kind="wrap">…</user_data> (data sections). */
  wrap?: string;
  /** Never clipped or dropped (static rules, controls, active restrictions). */
  required?: boolean;
  /** Own cap in characters (applied first, to every section that has one). */
  max?: number;
  /** Optional sections: lower keeps its space first when the total budget is short. */
  priority?: number;
}

export interface SectionReport {
  name: string;
  kind: SectionKind;
  chars: number;
  clipped: boolean;
  dropped: boolean;
}

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`);
const wrapped = (s: PromptSection, body: string) => (s.wrap ? `<user_data kind="${s.wrap}">\n${body}\n</user_data>` : body);
const SEP = '\n\n';
/** An optional section is clipped no shorter than this; below it, it is dropped whole. */
const MIN_USEFUL = 300;

/**
 * Join the sections in kind order (stable within a kind) within `budget` characters. Required sections always appear
 * in full (after their own `max`); optional ones keep their space by priority and are clipped (never mid-tag: the
 * user_data wrapper is added after clipping) or dropped when the rest doesn't fit.
 */
export function assemblePrompt(sections: PromptSection[], budget: number): { system: string; report: SectionReport[] } {
  const ordered = KIND_ORDER.flatMap((k) => sections.filter((s) => s.kind === k && s.text.trim()));
  const bodies = new Map<PromptSection, string>(ordered.map((s) => [s, s.max != null ? clip(s.text, s.max) : s.text]));
  const report = new Map<PromptSection, SectionReport>(
    ordered.map((s) => [s, { name: s.name, kind: s.kind, chars: 0, clipped: bodies.get(s) !== s.text, dropped: false }]),
  );
  const cost = (s: PromptSection) => wrapped(s, bodies.get(s)!).length + SEP.length;
  let remaining = budget - ordered.filter((s) => s.required).reduce((n, s) => n + cost(s), 0);
  const optional = ordered.filter((s) => !s.required).sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
  for (const s of optional) {
    const need = cost(s);
    if (need <= remaining) {
      remaining -= need;
      continue;
    }
    const overhead = need - bodies.get(s)!.length;
    const room = remaining - overhead;
    const r = report.get(s)!;
    if (room >= MIN_USEFUL) {
      bodies.set(s, clip(bodies.get(s)!, room));
      r.clipped = true;
      remaining -= cost(s);
    } else {
      bodies.delete(s);
      r.dropped = true;
    }
  }
  const parts: string[] = [];
  for (const s of ordered) {
    const body = bodies.get(s);
    if (body == null) continue;
    const text = wrapped(s, body);
    report.get(s)!.chars = text.length;
    parts.push(text);
  }
  return { system: parts.join(SEP), report: ordered.map((s) => report.get(s)!) };
}
