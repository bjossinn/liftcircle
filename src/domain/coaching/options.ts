/**
 * Option lists for the coach directory and coach applications (pure, no React).
 * Specialties are stored as stable slugs; unknown slugs (older/other clients) are prettified for display.
 */
import type { CoachFormat } from '@/backend/coachingContract';
import type { Goal } from '@/domain/types';
import { getLanguage, localeFor, t, type Language, type MessageKey } from '@/i18n';

export interface Option<T extends string = string> {
  value: T;
  label: string;
}

/** Option whose label is looked up in the current language each time it is read (the stored value never changes). */
const live = <T extends string>(value: T, key: MessageKey): Option<T> =>
  Object.freeze({
    value,
    get label() {
      return t(key);
    },
  });

export const SPECIALTIES: Option[] = [
  live('strength', 'program.kind.strength'),
  live('muscle_building', 'ui.muscle_building'),
  live('powerlifting', 'ui.powerlifting'),
  live('weightlifting', 'ui.olympic_weightlifting'),
  live('fat_loss', 'ui.fat_loss'),
  live('general_fitness', 'onboarding.goal.fitness'),
  live('beginners', 'ui.beginners'),
  live('running', 'onboarding.activity.run'),
  live('endurance', 'ui.endurance'),
  live('conditioning', 'workout.meta.pattern.conditioning'),
  live('calisthenics', 'ui.calisthenics'),
  live('mobility', 'workout.meta.pattern.mobility'),
  live('sports_performance', 'ui.sports_performance'),
  live('older_adults', 'ui.older_adults'),
  live('pre_postnatal', 'ui.pre_and_postnatal'),
  live('nutrition', 'ui.nutrition_habits'),
];

/** Coach-declared goals use the same codes as a client's training goal, so filters line up with intakes. */
export const COACH_GOALS: Option<Goal>[] = [
  live<Goal>('build_muscle', 'onboarding.goal.buildMuscle'),
  live<Goal>('strength', 'ui.get_stronger'),
  live<Goal>('lose_fat', 'onboarding.goal.loseFat'),
  live<Goal>('general_fitness', 'onboarding.goal.fitness'),
  live<Goal>('endurance', 'ui.endurance'),
];

const FORMAT_KEYS: Record<CoachFormat, MessageKey> = { in_person: 'coaching.directory.in_person', online: 'coaching.directory.online' };
export const formatLabel = (f: CoachFormat, language: Language = getLanguage()) => t(FORMAT_KEYS[f], undefined, language);
/** Display labels by format, read in the current language. */
export const FORMAT_LABELS: Record<CoachFormat, string> = Object.freeze(
  Object.defineProperties({} as Record<CoachFormat, string>, {
    in_person: { enumerable: true, get: () => formatLabel('in_person') },
    online: { enumerable: true, get: () => formatLabel('online') },
  }),
);

/** ISO 639-1 codes offered in the language pickers. */
export const LANGUAGE_CODES = [
  'en', 'is', 'da', 'no', 'sv', 'fi', 'de', 'nl', 'fr', 'es', 'pt', 'it', 'pl', 'cs', 'sk', 'hu', 'ro', 'bg', 'el', 'tr',
  'ru', 'uk', 'lt', 'lv', 'et', 'hr', 'sr', 'sl', 'ar', 'he', 'fa', 'hi', 'ur', 'bn', 'ta', 'zh', 'ja', 'ko', 'vi', 'th',
  'id', 'ms', 'tl', 'sw', 'af', 'ga', 'cy', 'fo',
] as const;

/** ISO 3166-1 alpha-2 codes. */
export const COUNTRY_CODES = [
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ', 'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ',
  'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS', 'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN', 'CO', 'CR',
  'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE', 'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FM', 'FO', 'FR',
  'GA', 'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HM', 'HN', 'HR', 'HT', 'HU',
  'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM', 'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ',
  'LA', 'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK', 'ML', 'MM', 'MN', 'MO', 'MP', 'MQ',
  'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA', 'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF',
  'PG', 'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW', 'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI',
  'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS', 'ST', 'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO', 'TR',
  'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI', 'VN', 'VU', 'WF', 'WS', 'YE', 'YT', 'ZA', 'ZM', 'ZW',
] as const;

const COUNTRY_SET = new Set<string>(COUNTRY_CODES);
export const isCountryCode = (c: string | null | undefined): c is string => !!c && COUNTRY_SET.has(c.toUpperCase());

const displayNameCache = new Map<string, Intl.DisplayNames | null>();
function displayNames(type: 'region' | 'language', language: Language): Intl.DisplayNames | null {
  const k = `${type}|${language}`;
  if (displayNameCache.has(k)) return displayNameCache.get(k)!;
  let dn: Intl.DisplayNames | null;
  try {
    dn = new Intl.DisplayNames([localeFor(language), 'en'], { type });
  } catch {
    dn = null;
  }
  displayNameCache.set(k, dn);
  return dn;
}

/** Country name in the current (or given) language; the stored value stays the ISO code. */
export function countryName(code: string | null | undefined, language: Language = getLanguage()): string {
  if (!code) return '';
  const c = code.toUpperCase();
  try {
    return displayNames('region', language)?.of(c) ?? c;
  } catch {
    return c;
  }
}

export function languageName(code: string | null | undefined, language: Language = getLanguage()): string {
  if (!code) return '';
  try {
    return displayNames('language', language)?.of(code.toLowerCase()) ?? code;
  } catch {
    return code;
  }
}

/** Countries sorted by name in the display language. */
export function countryOptions(language: Language = getLanguage()): Option[] {
  return COUNTRY_CODES.map((c) => ({ value: c, label: countryName(c, language) })).sort((a, b) => a.label.localeCompare(b.label, localeFor(language)));
}

export function languageOptions(language: Language = getLanguage()): Option[] {
  return LANGUAGE_CODES.map((c) => ({ value: c, label: languageName(c, language) })).sort((a, b) => a.label.localeCompare(b.label, localeFor(language)));
}

const SPECIALTY_MAP = new Map(SPECIALTIES.map((o) => [o.value, o]));
const GOAL_MAP = new Map<string, Option>(COACH_GOALS.map((o) => [o.value, o]));
const prettify = (s: string) => {
  const x = s.replace(/[_-]+/g, ' ').trim();
  return x ? x[0]!.toUpperCase() + x.slice(1) : s;
};
/** Display label for a stored specialty slug (unknown slugs from other clients are prettified, not translated). */
export const specialtyLabel = (s: string) => SPECIALTY_MAP.get(s)?.label ?? prettify(s);
export const coachGoalLabel = (g: string) => GOAL_MAP.get(g)?.label ?? prettify(g);

/**
 * Best-effort default country from the device time zone. Only a starting value for a select the user
 * can change — never a location lookup.
 */
const TZ_COUNTRY: Record<string, string> = {
  'Atlantic/Reykjavik': 'IS', 'Europe/London': 'GB', 'Europe/Dublin': 'IE', 'Europe/Oslo': 'NO', 'Europe/Stockholm': 'SE',
  'Europe/Copenhagen': 'DK', 'Atlantic/Faroe': 'FO', 'Europe/Helsinki': 'FI', 'Europe/Tallinn': 'EE', 'Europe/Riga': 'LV',
  'Europe/Vilnius': 'LT', 'Europe/Berlin': 'DE', 'Europe/Amsterdam': 'NL', 'Europe/Brussels': 'BE', 'Europe/Luxembourg': 'LU',
  'Europe/Paris': 'FR', 'Europe/Madrid': 'ES', 'Atlantic/Canary': 'ES', 'Europe/Lisbon': 'PT', 'Europe/Rome': 'IT',
  'Europe/Zurich': 'CH', 'Europe/Vienna': 'AT', 'Europe/Prague': 'CZ', 'Europe/Bratislava': 'SK', 'Europe/Warsaw': 'PL',
  'Europe/Budapest': 'HU', 'Europe/Bucharest': 'RO', 'Europe/Sofia': 'BG', 'Europe/Athens': 'GR', 'Europe/Istanbul': 'TR',
  'Europe/Kiev': 'UA', 'Europe/Kyiv': 'UA', 'Europe/Zagreb': 'HR', 'Europe/Belgrade': 'RS', 'Europe/Ljubljana': 'SI',
  'Europe/Malta': 'MT', 'Asia/Nicosia': 'CY', 'America/New_York': 'US', 'America/Chicago': 'US', 'America/Denver': 'US',
  'America/Phoenix': 'US', 'America/Los_Angeles': 'US', 'America/Anchorage': 'US', 'Pacific/Honolulu': 'US',
  'America/Toronto': 'CA', 'America/Vancouver': 'CA', 'America/Edmonton': 'CA', 'America/Winnipeg': 'CA', 'America/Halifax': 'CA',
  'America/Mexico_City': 'MX', 'America/Sao_Paulo': 'BR', 'America/Argentina/Buenos_Aires': 'AR', 'America/Santiago': 'CL',
  'America/Bogota': 'CO', 'America/Lima': 'PE', 'Australia/Sydney': 'AU', 'Australia/Melbourne': 'AU', 'Australia/Brisbane': 'AU',
  'Australia/Perth': 'AU', 'Australia/Adelaide': 'AU', 'Pacific/Auckland': 'NZ', 'Asia/Tokyo': 'JP', 'Asia/Seoul': 'KR',
  'Asia/Shanghai': 'CN', 'Asia/Hong_Kong': 'HK', 'Asia/Taipei': 'TW', 'Asia/Singapore': 'SG', 'Asia/Kuala_Lumpur': 'MY',
  'Asia/Bangkok': 'TH', 'Asia/Jakarta': 'ID', 'Asia/Manila': 'PH', 'Asia/Kolkata': 'IN', 'Asia/Calcutta': 'IN', 'Asia/Dubai': 'AE',
  'Asia/Jerusalem': 'IL', 'Africa/Johannesburg': 'ZA', 'Africa/Lagos': 'NG', 'Africa/Nairobi': 'KE', 'Africa/Cairo': 'EG',
};
export function countryFromTimeZone(tz: string | null | undefined): string {
  return (tz && TZ_COUNTRY[tz]) || '';
}
