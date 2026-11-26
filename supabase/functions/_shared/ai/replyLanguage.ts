/**
 * Which language the server writes its own sentences in (summaries, warnings, errors, the "Reply language" line for the
 * model) — pure and dependency-free, shared by the ai-coach function and the app.
 *
 * Order (Icelandic localization, roadmap item 8):
 *  1. an explicit request in the current message ("answer in English", "svaraðu á íslensku");
 *  2. the clear language of the current message (lang.ts detectLang);
 *  3. the app language the request carries (`language` in the send body: Settings.language);
 *  4. earlier messages (newest first — the open request, history, finally the model's own reply);
 *  5. English.
 * "ok", "👍" and other messages that show no language never force English when the app language is Icelandic.
 * The language never affects identity, scopes, sharing or any other decision.
 */
// @ts-ignore Deno requires the .ts extension; the app tsconfig does not enable allowImportingTsExtensions.
import { detectLang, type Lang } from './lang.ts';

/** The validated `language` field of a request: 'en' | 'is', anything else is treated as absent. */
export function requestLanguage(value: unknown): Lang | null {
  return value === 'en' || value === 'is' ? value : null;
}

const VERB_EN = '(?:reply|answer|respond|write|talk|speak|switch(?:\\s+back)?(?:\\s+to)?|continue|keep\\s+going)';
const VERB_IS = '(?:svara(?:ðu|du)?|skrifa(?:ðu|du)?|tala(?:ðu|du)?|haltu\\s+áfram|skiptu\\s+yfir|skipta\\s+yfir)';
const START = '(?:^|[^\\p{L}\\p{N}])';
const END = '(?![\\p{L}\\p{N}])';
const ASK: [RegExp, Lang][] = [
  [new RegExp(`${START}${VERB_EN}(?:\\s+(?:to\\s+)?me)?(?:\\s+(?:only|just))?\\s+(?:in\\s+)?english${END}`, 'giu'), 'en'],
  [new RegExp(`${START}(?:in\\s+)?english\\s+please${END}`, 'giu'), 'en'],
  [new RegExp(`${START}${VERB_IS}(?:\\s+(?:mér|mer|við\\s+mig))?(?:\\s+bara)?\\s+(?:á|a)\\s+ensku${END}`, 'giu'), 'en'],
  [new RegExp(`${START}${VERB_EN}(?:\\s+(?:to\\s+)?me)?(?:\\s+(?:only|just))?\\s+(?:in\\s+)?icelandic${END}`, 'giu'), 'is'],
  [new RegExp(`${START}(?:in\\s+)?icelandic\\s+please${END}`, 'giu'), 'is'],
  [new RegExp(`${START}${VERB_IS}(?:\\s+(?:mér|mer|við\\s+mig))?(?:\\s+bara)?\\s+(?:á|a)\\s+íslensku${END}`, 'giu'), 'is'],
  [new RegExp(`${START}(?:á|a)\\s+(?:íslensku|islensku)\\s+(?:takk|please)${END}`, 'giu'), 'is'],
  [new RegExp(`${START}(?:á|a)\\s+ensku\\s+(?:takk|please)${END}`, 'giu'), 'en'],
];

/** The language the message explicitly asks the assistant to use, or null. The last request in the message wins. */
export function requestedReplyLang(text: string | null | undefined): Lang | null {
  const t = String(text ?? '').normalize('NFC');
  let best: { at: number; lang: Lang } | null = null;
  for (const [re, lang] of ASK) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) {
      if (!best || m.index >= best.at) best = { at: m.index, lang };
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return best?.lang ?? null;
}

export interface ReplyLangInput {
  /** The current message. */
  text: string | null | undefined;
  /** Earlier text, newest first (open request, previous user messages, finally the model's reply). */
  history?: readonly (string | null | undefined)[];
  /** The request's validated app language (Settings.language), if it sent one. */
  setting?: Lang | null;
}

/** The effective reply language (see the order above). */
export function resolveReplyLang({ text, history = [], setting = null }: ReplyLangInput): Lang {
  const asked = requestedReplyLang(text);
  if (asked) return asked;
  const current = detectLang(text);
  if (current) return current;
  const s = requestLanguage(setting);
  if (s) return s;
  for (const h of history) {
    const l = detectLang(h);
    if (l) return l;
  }
  return 'en';
}

/** The line added to the system prompt so the model answers in the resolved language (protocol stays English). */
export function replyLanguageLine(lang: Lang, how: 'asked' | 'message' | 'setting' | 'history'): string {
  const name = lang === 'is' ? 'Icelandic' : 'English';
  if (how === 'asked') return `Reply language: ${name} (the user asked for it in their latest message).`;
  if (how === 'message') return `Reply language: ${name} (the language of the user's latest message).`;
  return `Reply language: ${name} (the user's app language). Use it unless the user's latest message is clearly written in another language.`;
}

/** Why resolveReplyLang chose its answer (for the prompt line). */
export function replyLangSource({ text, setting = null }: ReplyLangInput): 'asked' | 'message' | 'setting' | 'history' {
  if (requestedReplyLang(text)) return 'asked';
  if (detectLang(text)) return 'message';
  return requestLanguage(setting) ? 'setting' : 'history';
}
