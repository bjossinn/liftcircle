/**
 * Post-processing of the model's final text (pure).
 *
 *  - splitWhy: the system prompt asks for optional reasoning after a line `[[why]]`. That part is returned
 *    separately (stored in ai_messages.why, rendered collapsed under "Why this?"). Robust to the model
 *    omitting it, using a heading instead ("Why this?", "**Why:**"), a closing tag, or putting nothing after it.
 *  - tidyReply: removes boilerplate the style rules forbid (a leading "Great question!", trailing generic offers
 *    such as "Let me know if you have any other questions") and excess blank lines. It never rewrites content.
 */

/** The requested marker, anywhere. */
const TAG = /\[\[\s*why\s*\]\]|<why>/i;
/** Fallback: a "Why this?" heading or bold label at the start of a line. */
const HEADING = /(?:^|\n)[ \t]*(?:#{1,4}[ \t]*why(?: this)?\??:?|\*\*why(?: this)?\??:?\*\*:?)[ \t]*(?=\n|$)/i;
const CLOSERS = /\[\[\s*\/\s*why\s*\]\]|<\/why>/gi;
const WHY_MAX = 1500;

export function splitWhy(text: string): { answer: string; why: string | null } {
  const t = String(text ?? '');
  const m = TAG.exec(t) ?? HEADING.exec(t);
  if (!m) return { answer: t.replace(CLOSERS, '').trim(), why: null };
  const answer = t.slice(0, m.index).replace(CLOSERS, '').trim();
  const why = t.slice(m.index + m[0].length).replace(CLOSERS, '').trim();
  if (!answer) return { answer: why, why: null }; // the model put everything after the marker
  return { answer, why: why ? why.slice(0, WHY_MAX) : null };
}

const LEADING_FILLER = /^(?:(?:great|good|excellent) question[.!]?|absolutely[.!]|sure(?: thing)?[.!,]|of course[.!,]|happy to help[.!])\s*/i;
const TRAILING_OFFER =
  /\n+[ \t]*(?:let me know if (?:you (?:have|need)|there(?:'|’)s)[^\n]*|feel free to (?:ask|reach out)[^\n]*|i hope this helps[^\n]*|hope this helps[^\n]*|happy training[!.]?)[ \t]*$/i;

export function tidyReply(text: string): string {
  let t = String(text ?? '').replace(/\r\n/g, '\n').trim();
  t = t.replace(LEADING_FILLER, '');
  for (let i = 0; i < 2; i++) t = t.replace(TRAILING_OFFER, '').trimEnd();
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

/** Word count used by tests and the content-free log (routine answers should be ~40–100 words). */
export function wordCount(text: string): number {
  return (String(text ?? '').match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) ?? []).length;
}
