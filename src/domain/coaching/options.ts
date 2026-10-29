/**
 * Option lists for the coach directory and coach applications (pure, no React).
 * Specialties are stored as stable slugs; unknown slugs (older/other clients) are prettified for display.
 */
import type { CoachFormat } from '@/backend/coachingContract';
import type { Goal } from '@/domain/types';

export interface Option<T extends string = string> {
  value: T;
  label: string;
}

export const SPECIALTIES: Option[] = [
  { value: 'strength', label: 'Strength' },
  { value: 'muscle_building', label: 'Muscle building' },
  { value: 'powerlifting', label: 'Powerlifting' },
  { value: 'weightlifting', label: 'Olympic weightlifting' },
  { value: 'fat_loss', label: 'Fat loss' },
  { value: 'general_fitness', label: 'General fitness' },
  { value: 'beginners', label: 'Beginners' },
  { value: 'running', label: 'Running' },
  { value: 'endurance', label: 'Endurance' },
  { value: 'conditioning', label: 'Conditioning' },
  { value: 'calisthenics', label: 'Calisthenics' },
  { value: 'mobility', label: 'Mobility' },
  { value: 'sports_performance', label: 'Sports performance' },
  { value: 'older_adults', label: 'Older adults' },
  { value: 'pre_postnatal', label: 'Pre- and postnatal' },
  { value: 'nutrition', label: 'Nutrition habits' },
];

/** Coach-declared goals use the same codes as a client's training goal, so filters line up with intakes. */
export const COACH_GOALS: Option<Goal>[] = [
  { value: 'build_muscle', label: 'Build muscle' },
  { value: 'strength', label: 'Get stronger' },
  { value: 'lose_fat', label: 'Lose fat' },
  { value: 'general_fitness', label: 'General fitness' },
  { value: 'endurance', label: 'Endurance' },
];

export const FORMAT_LABELS: Record<CoachFormat, string> = {
  in_person: 'In person',
  online: 'Online',
};

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

let regionNames: Intl.DisplayNames | null | undefined;
let languageNames: Intl.DisplayNames | null | undefined;
function displayNames(type: 'region' | 'language'): Intl.DisplayNames | null {
  try {
    if (type === 'region') return (regionNames ??= new Intl.DisplayNames(['en'], { type: 'region' }));
    return (languageNames ??= new Intl.DisplayNames(['en'], { type: 'language' }));
  } catch {
    return null;
  }
}

export function countryName(code: string | null | undefined): string {
  if (!code) return '';
  const c = code.toUpperCase();
  try {
    return displayNames('region')?.of(c) ?? c;
  } catch {
    return c;
  }
}

export function languageName(code: string | null | undefined): string {
  if (!code) return '';
  try {
    return displayNames('language')?.of(code.toLowerCase()) ?? code;
  } catch {
    return code;
  }
}

/** Countries sorted by English name. */
export function countryOptions(): Option[] {
  return COUNTRY_CODES.map((c) => ({ value: c, label: countryName(c) })).sort((a, b) => a.label.localeCompare(b.label, 'en'));
}

export function languageOptions(): Option[] {
  return LANGUAGE_CODES.map((c) => ({ value: c, label: languageName(c) })).sort((a, b) => a.label.localeCompare(b.label, 'en'));
}

const SPECIALTY_MAP = new Map(SPECIALTIES.map((o) => [o.value, o.label]));
const GOAL_MAP = new Map<string, string>(COACH_GOALS.map((o) => [o.value, o.label]));
const prettify = (s: string) => {
  const t = s.replace(/[_-]+/g, ' ').trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : s;
};
export const specialtyLabel = (s: string) => SPECIALTY_MAP.get(s) ?? prettify(s);
export const coachGoalLabel = (g: string) => GOAL_MAP.get(g) ?? prettify(g);

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
