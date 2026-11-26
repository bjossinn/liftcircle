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

/**
 * A negation right before a request ("ekki svara á ensku", "don't answer in Icelandic", "not in English please",
 * "please never reply in English") turns it into a refusal of that language, so it never selects it. Such a clause is
 * skipped and the language falls through to the normal resolution (the message's own language, the app setting, …).
 * Only a negation directly before the request counts — politeness words may stand between them ("don't please reply in
 * English", "ekki vinsamlegast svara á ensku") — and "No, answer in English" (comma) still asks for English.
 *
 * Overlapping request patterns are ONE request: "Ekki svara á ensku takk" matches both "svara á ensku" and "á ensku takk",
 * "Don't reply in English please" both "reply in English" and "in English please". The negation is judged at the start
 * of the whole request, so a politeness word after a negated request ("takk", "please", "thanks") never turns its tail
 * into a fresh, un-negated request.
 */
const POLITE = '(?:please|pls|plz|kindly|thanks|thank\\s+you|takk(?:\\s+fyrir)?|vinsamlegast|endilega)';
const NEGATED = new RegExp(
  `${START}(?:ekki|aldrei|no|not|never|don['’]?t|do\\s+not|doesn['’]?t|does\\s+not|won['’]?t|will\\s+not)\\s+(?:${POLITE}\\s+)*(?:to\\s+)?$`,
  'iu',
);

/** Where a request's first letter is (the match may begin with the separator before it). */
const letterAt = (m: RegExpExecArray) => m.index + (/^[^\p{L}\p{N}]*/u.exec(m[0])?.[0].length ?? 0);

/** Every request in the message, in order: the language and whether it was refused ("ekki svara á ensku"). */
function replyRequests(text: string | null | undefined): { at: number; lang: Lang; refused: boolean }[] {
  const t = String(text ?? '').normalize('NFC');
  const hits: { start: number; end: number; lang: Lang }[] = [];
  for (const [re, lang] of ASK) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) {
      hits.push({ start: letterAt(m), end: m.index + m[0].length, lang });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  // Merge overlapping matches into whole requests; each is negated or not as a whole.
  hits.sort((a, b) => a.start - b.start);
  const out: { at: number; lang: Lang; refused: boolean }[] = [];
  for (let i = 0; i < hits.length; ) {
    let end = hits[i].end;
    let j = i + 1;
    while (j < hits.length && hits[j].start < end) end = Math.max(end, hits[j++].end);
    const refused = NEGATED.test(t.slice(0, hits[i].start));
    const last = hits.slice(i, j).reduce((a, b) => (b.start >= a.start ? b : a));
    out.push({ at: last.start, lang: last.lang, refused });
    i = j;
  }
  return out;
}

/** The language the message explicitly asks the assistant to use, or null. The last request in the message wins. */
export function requestedReplyLang(text: string | null | undefined): Lang | null {
  return replyRequests(text).filter((r) => !r.refused).pop()?.lang ?? null;
}

/** The language the message explicitly refuses ("Ekki svara á ensku takk", "Don't reply in English please") and never
 *  asks for elsewhere, or null. It is never chosen, not even when the message itself is written in it. */
export function refusedReplyLang(text: string | null | undefined): Lang | null {
  const reqs = replyRequests(text);
  const refused = reqs.filter((r) => r.refused).map((r) => r.lang);
  const asked = new Set(reqs.filter((r) => !r.refused).map((r) => r.lang));
  const only = [...new Set(refused)].filter((l) => !asked.has(l));
  return only.length === 1 ? only[0] : null;
}
const other = (l: Lang): Lang => (l === 'en' ? 'is' : 'en');

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
  // A refused language is skipped at every later step; with two languages, refusing one leaves the other.
  const refused = refusedReplyLang(text);
  if (refused) return other(refused);
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
export function replyLanguageLine(lang: Lang, how: 'asked' | 'refused' | 'message' | 'setting' | 'history'): string {
  const name = lang === 'is' ? 'Icelandic' : 'English';
  if (how === 'refused') return `Reply language: ${name} (the user asked not to be answered in ${lang === 'is' ? 'English' : 'Icelandic'}).`;
  if (how === 'asked') return `Reply language: ${name} (the user asked for it in their latest message).`;
  if (how === 'message') return `Reply language: ${name} (the language of the user's latest message).`;
  return `Reply language: ${name} (the user's app language). Use it unless the user's latest message is clearly written in another language.`;
}

/** Why resolveReplyLang chose its answer (for the prompt line). */
export function replyLangSource({ text, setting = null }: ReplyLangInput): 'asked' | 'refused' | 'message' | 'setting' | 'history' {
  if (requestedReplyLang(text)) return 'asked';
  if (refusedReplyLang(text)) return 'refused';
  if (detectLang(text)) return 'message';
  return requestLanguage(setting) ? 'setting' : 'history';
}
