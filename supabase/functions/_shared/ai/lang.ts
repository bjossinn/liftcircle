/**
 * Reply language for server-written text (1.0.3): summaries, fallbacks and dates follow the language the user writes in.
 * The model already replies in the user's language (SYSTEM_RULES "Language"); this keeps the server's own sentences in
 * step. Pure and dependency-free (shared by the ai-coach function and the app).
 */
export type Lang = 'en' | 'is';

const IS_LETTERS = /[ðþæÐÞÆ]/;
const IS_WORDS = new Set([
  'ég', 'eg', 'og', 'ekki', 'er', 'að', 'við', 'mig', 'mér', 'mer', 'takk', 'já', 'ja', 'nei', 'fyrir', 'viku', 'vikuna', 'næstu', 'þessa', 'hvað', 'hvernig',
  'get', 'vil', 'gerðu', 'prófaðu', 'núna', 'nuna', 'matarplan', 'æfing', 'æfingu', 'æfingar', 'í', 'á', 'um', 'með', 'án', 'eða', 'líka', 'mjög', 'svo',
  'hæ', 'halló', 'endilega', 'kannski', 'bara', 'ég', 'þú', 'þetta', 'það', 'dag', 'morgun', 'engar', 'enginn', 'engin', 'ekkert',
]);
const EN_WORDS = new Set([
  // ("ok"/"okay" are left out: Icelanders say them too, so they decide nothing.)
  'i', 'the', 'and', 'is', 'to', 'my', 'me', 'you', 'what', 'how', 'can', 'please', 'week', 'today', 'tomorrow', 'make', 'plan', 'thanks', 'yes', 'no',
  'want', 'with', 'without', 'for', 'this', 'next', 'do', 'it', 'a', 'an', 'of', 'in', 'on', "i'm", "don't", 'hi', 'hello', 'try', 'again', 'now',
]);

/** 'is' or 'en' when the text shows it; null when it can't tell (e.g. "ok", "👍"). */
export function detectLang(text: string | null | undefined): Lang | null {
  const t = String(text ?? '').toLowerCase();
  if (!t.trim()) return null;
  if (IS_LETTERS.test(t)) return 'is';
  const words = t.match(/[\p{L}'’]+/gu) ?? [];
  let is = 0;
  let en = 0;
  for (const w of words) {
    if (IS_WORDS.has(w)) is++;
    if (EN_WORDS.has(w.replace('’', "'"))) en++;
  }
  if (/[áéíóúýö]/.test(t) && is >= 1) return 'is';
  if (is > en) return 'is';
  if (en > 0) return 'en';
  return null;
}

/** The language of the newest message, else of the earlier ones (newest first), else English. */
export function replyLang(...texts: (string | null | undefined)[]): Lang {
  for (const t of texts) {
    const l = detectLang(t);
    if (l) return l;
  }
  return 'en';
}
