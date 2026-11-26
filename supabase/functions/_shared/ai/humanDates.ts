/**
 * Human-friendly dates for AI text and cards (pure, dependency-free; shared by the ai-coach function and the app).
 * Users never see ISO dates: "today", "tomorrow", a weekday later in the current week, otherwise "Sat 31 Oct".
 * Dates are calendar dates already in the user's time zone (the server computes "today" there), formatted on the UTC
 * calendar date. English (en-GB) by default; Icelandic (1.0.3) when the reply is in Icelandic: "lau. 31. okt.", and
 * humanDate gives phrases that read after a verb: "í dag", "á morgun", "á laugardaginn", "á lau. 31. okt.".
 */
import type { Lang } from './lang.ts';
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WD_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const WD_IS = ['sun.', 'mán.', 'þri.', 'mið.', 'fim.', 'fös.', 'lau.'];
const WD_IS_DEF = ['sunnudaginn', 'mánudaginn', 'þriðjudaginn', 'miðvikudaginn', 'fimmtudaginn', 'föstudaginn', 'laugardaginn'];
const MON_IS = ['jan.', 'feb.', 'mar.', 'apr.', 'maí', 'jún.', 'júl.', 'ágú.', 'sep.', 'okt.', 'nóv.', 'des.'];

const parts = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return { wd: d.getUTCDay(), day: d.getUTCDate(), mon: d.getUTCMonth(), ms: d.getTime() };
};

/** "Sat 31 Oct" / "lau. 31. okt.". */
export function shortDate(iso: string, lang: Lang = 'en'): string {
  if (!ISO.test(iso)) return iso;
  const p = parts(iso);
  if (Number.isNaN(p.ms)) return iso;
  return lang === 'is' ? `${WD_IS[p.wd]} ${p.day}. ${MON_IS[p.mon]}` : `${WD[p.wd]} ${p.day} ${MON[p.mon]}`;
}

/** "today", "tomorrow", "Saturday" (later this week; weeks start Monday unless weekStart is 0), otherwise "Sat 31 Oct". */
export function humanDate(iso: string, today?: string | null, weekStart: 0 | 1 = 1, lang: Lang = 'en'): string {
  if (!ISO.test(iso)) return iso;
  if (!today || !ISO.test(today)) return lang === 'is' ? `á ${shortDate(iso, lang)}` : shortDate(iso);
  const diff = Math.round((parts(iso).ms - parts(today).ms) / 86_400_000);
  if (diff === 0) return lang === 'is' ? 'í dag' : 'today';
  if (diff === 1) return lang === 'is' ? 'á morgun' : 'tomorrow';
  const daysLeftInWeek = (weekStart + 6 - parts(today).wd + 7) % 7;
  if (diff > 1 && diff <= daysLeftInWeek) return lang === 'is' ? `á ${WD_IS_DEF[parts(iso).wd]}` : WD_LONG[parts(iso).wd];
  return lang === 'is' ? `á ${shortDate(iso, lang)}` : shortDate(iso);
}

/** "Fri 30 and Sat 31 Oct" / "Fri 31 Oct and Sat 1 Nov". */
export function datePair(a: string, b: string): string {
  if (!ISO.test(a) || !ISO.test(b)) return `${a} and ${b}`;
  const pa = parts(a);
  const pb = parts(b);
  return pa.mon === pb.mon ? `${WD[pa.wd]} ${pa.day} and ${shortDate(b)}` : `${shortDate(a)} and ${shortDate(b)}`;
}

const WD_PREFIX = '(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\\.?,?\\s+)?';

/**
 * Replaces ISO dates in free text with human ones. "Sat 2026-10-31" (weekday already written) becomes "Sat 31 Oct";
 * a bare date becomes today/tomorrow/weekday/"Sat 31 Oct". Text inside [[open:…]] markers is left alone.
 */
export function humanizeDates(text: string, today?: string | null, weekStart: 0 | 1 = 1, lang: Lang = 'en'): string {
  const re = new RegExp(`${WD_PREFIX}(\\d{4}-\\d{2}-\\d{2})(?!\\d)(\\.?)`, 'g');
  return String(text ?? '')
    .split(/(\[\[[^\]]*\]\])/)
    .map((chunk, i) => (i % 2 === 1 ? chunk : chunk.replace(re, (m, iso: string, dot: string) => {
      if (Number.isNaN(Date.parse(`${iso}T00:00:00Z`))) return m;
      // Icelandic free text: always "lau. 31. okt." (no preposition, so it fits any sentence); a sentence-ending period
      // right after it is not doubled ("okt.." → "okt.").
      if (lang === 'is') {
        const d = shortDate(iso, 'is');
        return d.endsWith('.') ? d : `${d}${dot}`;
      }
      const whole = m.slice(0, m.length - dot.length);
      return `${whole === iso ? humanDate(iso, today, weekStart) : shortDate(iso)}${dot}`;
    })))
    .join('');
}
