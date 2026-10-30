/**
 * Human-friendly dates for AI text and cards (pure, dependency-free; shared by the ai-coach function and the app).
 * Users never see ISO dates: "today", "tomorrow", a weekday later in the current week, otherwise "Sat 31 Oct".
 * Dates are calendar dates already in the user's time zone (the server computes "today" there), and the app's
 * language is English, so formatting is fixed en-GB on the UTC calendar date.
 */
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WD_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

const parts = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return { wd: d.getUTCDay(), day: d.getUTCDate(), mon: d.getUTCMonth(), ms: d.getTime() };
};

/** "Sat 31 Oct". */
export function shortDate(iso: string): string {
  if (!ISO.test(iso)) return iso;
  const p = parts(iso);
  return Number.isNaN(p.ms) ? iso : `${WD[p.wd]} ${p.day} ${MON[p.mon]}`;
}

/** "today", "tomorrow", "Saturday" (later this week; weeks start Monday unless weekStart is 0), otherwise "Sat 31 Oct". */
export function humanDate(iso: string, today?: string | null, weekStart: 0 | 1 = 1): string {
  if (!ISO.test(iso)) return iso;
  if (!today || !ISO.test(today)) return shortDate(iso);
  const diff = Math.round((parts(iso).ms - parts(today).ms) / 86_400_000);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  const daysLeftInWeek = (weekStart + 6 - parts(today).wd + 7) % 7;
  if (diff > 1 && diff <= daysLeftInWeek) return WD_LONG[parts(iso).wd];
  return shortDate(iso);
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
export function humanizeDates(text: string, today?: string | null, weekStart: 0 | 1 = 1): string {
  const re = new RegExp(`${WD_PREFIX}(\\d{4}-\\d{2}-\\d{2})(?!\\d)`, 'g');
  return String(text ?? '')
    .split(/(\[\[[^\]]*\]\])/)
    .map((chunk, i) => (i % 2 === 1 ? chunk : chunk.replace(re, (m, iso: string) => {
      if (Number.isNaN(Date.parse(`${iso}T00:00:00Z`))) return m;
      return m === iso ? humanDate(iso, today, weekStart) : shortDate(iso);
    })))
    .join('');
}
