/**
 * Render-time localization of generated program text.
 *
 * Plans store their generated text (rationale, warnings, version reasons, session names/focus, warm-up cues, notes)
 * as canonical English: the generator renders it from the `en` dictionary by message key (see generator.ts `E`/`EP`),
 * which is byte-identical to the English plans have always stored. Stored data therefore never depends on the UI
 * language, and older plans are handled exactly like new ones.
 *
 * `localizeGeneratedText` recognises those messages EXACTLY — a whole-string match against each message's English
 * template, with every placeholder restricted to the values the generator can produce (enumerated labels, weekday
 * lists, integers, nested generated sentences) — and re-renders the same message key + params in the display
 * language. Anything it doesn't recognise (user or coach text, renamed sessions, AI prose) is returned unchanged.
 * There is no substring matching.
 */
import type { ActivityType, Equipment, LimitationArea, SessionTemplate, SplitKey } from '@/domain/types';
import { EN, getLanguage, listText, t, tp, type Language, type MessageKey, type Params, type PluralKey } from '@/i18n';
import { WEEKDAY_SHORT, weekdayShort } from '@/lib/dates';
import { CALIBRATION_CUE, EQUIPMENT_TEXT, EXPERIENCE_TEXT, GOAL_TEXT, LIMITATION_TEXT, lowerInitial } from './explain';
import { COVERAGE_GROUPS, MAJOR_MUSCLES, SPLITS, splitDescription, splitLabel } from './templates';

/* ================================================================ public API */

/** Display text for a stored generated string; unknown text is returned exactly as stored. */
export function localizeGeneratedText(text: string, language: Language = getLanguage()): string {
  if (language === 'en' || !text) return text;
  return localizeOrNull(text, language) ?? text;
}

/** `localizeGeneratedText` over a list (rationale / warnings). */
export function localizeGeneratedList(list: readonly string[], language: Language = getLanguage()): string[] {
  return list.map((s) => localizeGeneratedText(s, language));
}

/*
 * Provenance. Matching the exact English of a generated string does not prove the generator wrote it: a user can name
 * a session "Easy walk" or type a note that equals a generated one. So the user-editable template fields are only
 * localized when they are demonstrably generator text:
 *  - session name / focus / cardio notes: the template has an id the generator assigns (`fb3:a`, `act:walk`,
 *    `end:easy`, …; see `isGeneratedTemplateId`) and the field carries no edit marker (`nameEdited`,
 *    `cardio.notesEdited`, set by the program editor when someone saves that field). Custom (`custom:`), library,
 *    coach- and AI-created sessions have other ids and are always shown as stored — except the focus of a blank custom
 *    session, which the app itself writes (`emptyTemplate`) and nobody can edit.
 *  - exercise notes: shown verbatim once edited (`notesEdited`); otherwise only exact generator/app notes are localized.
 * Plans stored before the markers existed: a generator-id session that was renamed then is indistinguishable from one
 * that wasn't, so its name is localized only when it still equals a generated string; every other origin shows as
 * stored. Stored English is never rewritten.
 */
const ACT_ID = /^act:(?:walk|cardio|mobility|conditioning)$/;
const END_ID = /^end:(?:easy|long|steady)$/;
/** True when `id` is one the program generator gives the sessions it builds. */
export function isGeneratedTemplateId(id: string | undefined | null): boolean {
  if (!id) return false;
  if (ACT_ID.test(id) || END_ID.test(id)) return true;
  const parts = id.split(':');
  if (parts.length !== 2) return false;
  return Object.hasOwn(SPLITS, parts[0]) && SPLITS[parts[0] as SplitKey].days.some((d) => d.key === parts[1]);
}
type NameSource = Pick<SessionTemplate, 'name'> & Partial<Pick<SessionTemplate, 'id' | 'nameEdited'>>;
/** Session name for display: generated names are localized; renamed and non-generated sessions show as stored. */
export const sessionDisplayName = (s: NameSource, language: Language = getLanguage()) =>
  !s.nameEdited && isGeneratedTemplateId(s.id) ? localizeGeneratedText(s.name, language) : s.name;
const CUSTOM_FOCUS = () => en('program.rationale.custom');
export const sessionDisplayFocus = (s: Pick<SessionTemplate, 'focus'> & Partial<Pick<SessionTemplate, 'id'>>, language: Language = getLanguage()) =>
  isGeneratedTemplateId(s.id) || (s.id?.startsWith('custom:') && s.focus === CUSTOM_FOCUS()) ? localizeGeneratedText(s.focus, language) : s.focus;
/** Cardio notes of a session: localized only for an unedited generated session (pass the template). */
export const cardioNotesText = (s: Pick<SessionTemplate, 'id' | 'cardio'>, language: Language = getLanguage()) => {
  const notes = s.cardio?.notes ?? '';
  return !s.cardio?.notesEdited && isGeneratedTemplateId(s.id) ? localizeGeneratedText(notes, language) : notes;
};
export const warmupDisplayText = (rx: { warmup: string }, language: Language = getLanguage()) => localizeGeneratedText(rx.warmup, language);
export const rxNotesText = (rx: { notes?: string; notesEdited?: true }, language: Language = getLanguage()) =>
  rx.notes == null ? undefined : rx.notesEdited ? rx.notes : localizeGeneratedText(rx.notes, language);
/** A stored program name: generated default names are localized, names the user typed are shown as typed. */
export const programDisplayName = (name: string, language: Language = getLanguage()) => localizeGeneratedText(name, language);

/** Activity name by enum (`program.activity.*`), optionally a complete easy/long/steady variant. */
export function activityName(activity: ActivityType, variant?: 'easy' | 'long' | 'steady', language: Language = getLanguage()): string {
  return t(variant ? `program.activity.${activity}.${variant}` : `program.activity.${activity}`, undefined, language);
}

export { splitDescription, splitLabel };

/* ================================================================ recognizer */

const ACTIVITIES: ActivityType[] = ['walk', 'run', 'cycle', 'hike', 'swim', 'row', 'sport', 'class', 'yoga', 'mobility', 'stretch', 'custom'];
const en = (key: MessageKey) => EN[key] as string;

interface ParamType {
  /** Regex source (no capturing groups). */
  re: string;
  /** Localized value for the raw English capture, or null when it isn't a value the generator produces. */
  parse: (raw: string, lang: Language) => { value: string | number; count?: number } | null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alt = (values: string[]) => `(?:${[...values].sort((a, b) => b.length - a.length).map(escapeRe).join('|')})`;

const INT: ParamType = { re: '\\d+', parse: (raw) => ({ value: Number(raw) }) };
const DECIMAL: ParamType = { re: '\\d+(?:\\.\\d+)?', parse: (raw) => ({ value: Number(raw) }) };
/** "45" or "40–50" (digits and an en dash read the same in every language). */
const RANGE: ParamType = { re: '\\d+(?:–\\d+)?', parse: (raw) => ({ value: raw }) };

function enumType(table: ReadonlyArray<readonly [string, (lang: Language) => string]>): ParamType {
  const map = new Map(table);
  return { re: alt([...map.keys()]), parse: (raw, lang) => (map.has(raw) ? { value: map.get(raw)!(lang) } : null) };
}

/** English "A, B and C" list of `item` values → localized Intl list. Free-form items keep their text. */
function listType(item: ParamType, freeForm = false): ParamType {
  const re = freeForm ? '.+' : `${item.re}(?:, ${item.re})*(?: and ${item.re})?`;
  return {
    re,
    parse: (raw, lang) => {
      const parts = splitEnglishList(raw, freeForm ? null : item.re);
      if (!parts) return null;
      const out: string[] = [];
      for (const p of parts) {
        const v = item.parse(p, lang);
        if (!v) return null;
        out.push(String(v.value));
      }
      return { value: listText(out, lang), count: out.length };
    },
  };
}

function splitEnglishList(raw: string, itemRe: string | null): string[] | null {
  if (itemRe) {
    const parts: string[] = [];
    const re = new RegExp(`^(${itemRe})(?:, | and |$)`);
    let rest = raw;
    while (rest) {
      const m = re.exec(rest);
      if (!m) return null;
      parts.push(m[1]);
      rest = rest.slice(m[0].length);
    }
    return parts.length ? parts : null;
  }
  const lastAnd = raw.lastIndexOf(' and ');
  if (lastAnd < 0) return [raw];
  return [...raw.slice(0, lastAnd).split(', '), raw.slice(lastAnd + 5)];
}

/** A whole generated sentence nested in another message (e.g. the "why" of a split line). */
const NESTED: ParamType = {
  re: '.+',
  parse: (raw, lang) => {
    const v = localizeOrNull(raw, lang);
    return v == null ? null : { value: v };
  },
};

let types: Record<string, ParamType> | null = null;
function paramTypes(): Record<string, ParamType> {
  if (types) return types;
  const weekday = enumType(WEEKDAY_SHORT.map((d, i) => [d, (l: Language) => weekdayShort(i, l)] as const));
  const pair: ParamType = {
    re: `${weekday.re}–${weekday.re}`,
    parse: (raw, lang) => {
      const [a, b] = raw.split('–');
      const x = WEEKDAY_SHORT.indexOf(a);
      const y = WEEKDAY_SHORT.indexOf(b);
      return x < 0 || y < 0 ? null : { value: `${weekdayShort(x, lang)}–${weekdayShort(y, lang)}` };
    },
  };
  const goal = enumType(Object.entries(GOAL_TEXT).map(([g, s]) => [s, (l: Language) => t(`program.goalText.${g as keyof typeof GOAL_TEXT}`, undefined, l)] as const));
  const experience = enumType(
    Object.entries(EXPERIENCE_TEXT).map(([e, s]) => [s, (l: Language) => t(`program.experienceText.${e as keyof typeof EXPERIENCE_TEXT}`, undefined, l)] as const),
  );
  const equipment = enumType(
    (Object.entries(EQUIPMENT_TEXT) as [Equipment, string][]).map(([e, s]) => [s, (l: Language) => lowerInitial(t(`workout.meta.equipment.${e}`, undefined, l), l)] as const),
  );
  const limitation = enumType(
    (Object.entries(LIMITATION_TEXT) as [LimitationArea, string][]).map(([a, s]) => [s, (l: Language) => lowerInitial(t(`workout.meta.limitation.${a}`, undefined, l), l)] as const),
  );
  const COVERAGE_KEY: Record<string, MessageKey> = {
    squat: 'program.slot.squatLunge', hinge: 'program.slot.hinge', hpush: 'program.slot.horizontalPush', vpush: 'program.slot.verticalPush',
    hpull: 'program.slot.horizontalPull', vpull: 'program.slot.verticalPull', trunk: 'program.slot.trunk',
  };
  const pattern = enumType(COVERAGE_GROUPS.filter((g) => COVERAGE_KEY[g.key]).map((g) => [g.label, (l: Language) => lowerInitial(t(COVERAGE_KEY[g.key], undefined, l), l)] as const));
  const MUSCLE_KEY: Record<string, MessageKey> = {
    chest: 'program.slot.chest', back: 'program.slot.back', shoulders: 'program.slot.shoulders', quads: 'program.slot.quads', posterior: 'program.slot.glutesHamstrings',
  };
  const muscle = enumType(MAJOR_MUSCLES.filter((m) => MUSCLE_KEY[m.key]).map((m) => [m.label.toLowerCase(), (l: Language) => lowerInitial(t(MUSCLE_KEY[m.key], undefined, l), l)] as const));
  const activityLower = enumType(ACTIVITIES.map((a) => [en(`program.activity.${a}`).toLowerCase(), (l: Language) => lowerInitial(t(`program.activity.${a}`, undefined, l), l)] as const));
  const activityName_ = enumType(ACTIVITIES.map((a) => [en(`program.activity.${a}`), (l: Language) => t(`program.activity.${a}`, undefined, l)] as const));
  // Non-lifting session names, lower-cased inside a sentence ("easy walk", "mobility").
  const extraKind = enumType(
    sessionNameKeys().map((k) => [en(k).toLowerCase(), (l: Language) => lowerInitial(t(k, undefined, l), l)] as const),
  );
  const sessionName: ParamType = { re: '.+?', parse: (raw, lang) => ({ value: staticText(raw, lang) ?? raw }) };
  const exercise: ParamType = { re: '.+?', parse: (raw) => ({ value: raw }) };
  const splitKeys = Object.keys(SPLITS) as SplitKey[];
  const split = enumType(splitKeys.map((k) => [SPLITS[k].label, (l: Language) => splitLabel(k, l)] as const));
  const splitDesc = enumType(splitKeys.map((k) => [SPLITS[k].description, (l: Language) => splitDescription(k, l)] as const));

  types = {
    int: INT,
    decimal: DECIMAL,
    range: RANGE,
    nested: NESTED,
    goal,
    experience,
    weekdays: listType(weekday),
    pairs: listType(pair),
    equipment: listType(equipment),
    limitations: listType(limitation),
    pattern,
    patterns: listType(pattern),
    muscles: listType(muscle),
    activity: activityLower,
    activityName: activityName_,
    activities: listType(extraKind),
    sessions: listType(sessionName, true),
    exercises: listType(exercise, true),
    split,
    splitDesc,
  };
  return types;
}

/** Keys of generated session names (the activities list in the rationale lower-cases them). */
function sessionNameKeys(): MessageKey[] {
  const keys: MessageKey[] = [
    'program.generator.easyWalk', 'program.generator.easyYoga', 'program.generator.stretching', 'program.generator.mobility',
    'program.generator.conditioningIntervals',
  ];
  for (const a of ACTIVITIES) for (const v of ['easy', 'long', 'steady'] as const) keys.push(`program.activity.${a}.${v}`);
  return keys;
}

interface MessagePattern {
  /** A message key, or a plural base (both `.one` and `.other` English variants are recognised). */
  key: MessageKey | PluralKey;
  plural?: boolean;
  params: Record<string, keyof ReturnType<typeof paramTypes>>;
  /** Plural count: a numeric param, or the item count of a list param (`#muscles`). Default `count`. */
  count?: string;
}

/** Every parameterised message the generator / program code stores. */
const MESSAGES: MessagePattern[] = [
  { key: 'program.rationale.goal', params: { goal: 'goal', experience: 'experience' } },
  { key: 'program.rationale.goalSecondary', params: { goal: 'goal', secondaryGoal: 'goal', experience: 'experience' } },
  { key: 'program.rationale.chosenStructure', plural: true, params: { count: 'int' } },
  { key: 'program.rationale.recommendedStructure', plural: true, params: { count: 'int' } },
  { key: 'program.rationale.recommendedStructureOptions', plural: true, params: { count: 'int' } },
  { key: 'program.rationale.splitRationale', params: { splitLabel: 'split', splitDescription: 'splitDesc', why: 'nested' } },
  { key: 'program.rationale.enduranceRecent', plural: true, params: { activity: 'activity', count: 'int', minutes: 'int' } },
  { key: 'program.rationale.enduranceCalibrate', plural: true, params: { activity: 'activity', count: 'int' } },
  { key: 'program.rationale.noEnduranceDays', params: { activity: 'activity' } },
  { key: 'program.rationale.supportingStrength', plural: true, params: { count: 'int', splitLabel: 'split', splitDescription: 'splitDesc' } },
  { key: 'program.rationale.scheduleLifting', params: { liftingDays: 'weekdays' } },
  { key: 'program.rationale.scheduleEasy', params: { liftingDays: 'weekdays', otherDays: 'weekdays' } },
  { key: 'program.rationale.scheduleEndurance', params: { liftingDays: 'weekdays', otherDays: 'weekdays' } },
  { key: 'program.rationale.scheduleActivity', params: { days: 'weekdays' } },
  { key: 'program.rationale.activeDistribution', plural: true, count: 'easyDays', params: { total: 'int', liftingDays: 'int', easyDays: 'int', activities: 'activities' } },
  { key: 'program.rationale.activeAvailability', plural: true, count: 'available', params: { requested: 'int', available: 'int' } },
  { key: 'program.rationale.liftingAvailability', plural: true, count: 'available', params: { requested: 'int', available: 'int' } },
  { key: 'program.rationale.availableEquipment', params: { equipment: 'equipment' } },
  { key: 'program.rationale.duration', params: { minutes: 'int', estimate: 'range', durationExplanation: 'nested' } },
  { key: 'program.rationale.movementCoverage', params: { patterns: 'patterns' } },
  { key: 'program.rationale.trimmedPattern', params: { pattern: 'pattern', minutes: 'int' } },
  { key: 'program.rationale.missingPattern', params: { pattern: 'pattern' } },
  { key: 'program.rationale.missingVerticalPull', params: { pattern: 'pattern' } },
  { key: 'program.rationale.muscleFrequency', params: { count: 'int' } },
  { key: 'program.rationale.muscleCompromiseOnce', plural: true, count: '#muscles', params: { muscles: 'muscles' } },
  { key: 'program.rationale.muscleCompromiseZero', plural: true, count: '#muscles', params: { muscles: 'muscles' } },
  { key: 'program.rationale.muscleCompromiseOnceEndurance', plural: true, count: '#muscles', params: { muscles: 'muscles' } },
  { key: 'program.rationale.muscleCompromiseZeroEndurance', plural: true, count: '#muscles', params: { muscles: 'muscles' } },
  { key: 'program.rationale.accessoriesTrimmed', params: { minutes: 'int', sessions: 'sessions' } },
  { key: 'program.rationale.overBudget', params: { sessions: 'sessions', minutes: 'int' } },
  { key: 'program.rationale.consecutiveChosen', params: { days: 'pairs' } },
  { key: 'program.rationale.consecutiveUnavoidable', params: { days: 'pairs' } },
  { key: 'program.rationale.excluded', plural: true, params: { count: 'int' } },
  { key: 'program.rationale.enjoyed', params: { exercises: 'exercises' } },
  { key: 'program.rationale.enduranceStrengthCap', params: { count: 'int' } },
  { key: 'program.rationale.generatedShuffled', params: { count: 'int' } },
  { key: 'program.rationale.regenerated', params: { sessions: 'sessions' } },
  { key: 'program.rationale.endurancePlanName', params: { activity: 'activityName' } },
  { key: 'program.restoredVersion', params: { version: 'int' } },
  { key: 'program.explain.startingEffort', params: { rirPhrase: 'nested', rir: 'int', rirExplanation: 'nested' } },
  { key: 'program.explain.rirMany', params: { count: 'int' } },
  { key: 'program.explain.limitationRationale', params: { areas: 'limitations' } },
  { key: 'program.explain.blockRationale', params: { weeks: 'int', reviewWeek: 'int' } },
  { key: 'program.generator.enduranceMinutes', params: { minutes: 'int' } },
  { key: 'program.generator.enduranceMinutesDistance', params: { minutes: 'int', distance: 'decimal' } },
  { key: 'program.generator.enduranceDistance', params: { distance: 'decimal' } },
  { key: 'program.split.fallbackLifting', plural: true, params: { requestedSplit: 'split', count: 'int', actualSplit: 'split' } },
  { key: 'program.split.fallbackEndurance', plural: true, params: { requestedSplit: 'split', count: 'int', actualSplit: 'split' } },
  { key: 'program.split.recommendedLifting', plural: true, params: { requestedSplit: 'split', count: 'int', actualSplit: 'split' } },
  { key: 'program.split.recommendedEndurance', plural: true, params: { requestedSplit: 'split', count: 'int', actualSplit: 'split' } },
];

/** Static (placeholder-free) generated strings, in priority order when two keys share English text. */
const STATIC_PREFIXES = ['program.generator.', 'program.template.', 'program.rationale.', 'program.explain.', 'program.activity.', 'program.split.'];
/** Display-only explain strings: never stored on their own, so never recognised as whole stored strings. */
const STATIC_EXCLUDE = new Set<string>(['program.explain.restSeconds', 'program.explain.restMinutes', 'program.explain.restMinutesSeconds', 'program.explain.seconds', 'program.explain.repRange', 'program.explain.prescription']);

let staticMap: Map<string, MessageKey> | null = null;
function staticKeys(): Map<string, MessageKey> {
  if (staticMap) return staticMap;
  staticMap = new Map();
  const keys = Object.keys(EN) as MessageKey[];
  for (const prefix of STATIC_PREFIXES) {
    for (const k of keys) {
      if (!k.startsWith(prefix) || STATIC_EXCLUDE.has(k) || /\.(one|other)$/.test(k) || k.startsWith('program.split.tradeoff.')) continue;
      const v = en(k);
      if (v.includes('{{') || staticMap.has(v)) continue;
      staticMap.set(v, k);
    }
  }
  return staticMap;
}
function staticText(text: string, lang: Language): string | null {
  const k = staticKeys().get(text);
  return k ? t(k, undefined, lang) : null;
}

interface Compiled {
  p: MessagePattern;
  re: RegExp;
}
let compiled: Compiled[] | null = null;
function compiledPatterns(): Compiled[] {
  if (compiled) return compiled;
  const pt = paramTypes();
  compiled = [];
  for (const p of MESSAGES) {
    const variants = p.plural ? [`${p.key}.one`, `${p.key}.other`] : [p.key];
    const seen = new Set<string>();
    for (const k of variants) {
      const template = en(k as MessageKey);
      if (seen.has(template)) continue;
      seen.add(template);
      const used = new Set<string>();
      let src = '';
      let last = 0;
      for (const m of template.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g)) {
        src += escapeRe(template.slice(last, m.index));
        const name = m[1];
        const type = pt[p.params[name]];
        if (!type) throw new Error(`localize: no param type for ${k} {{${name}}}`);
        src += used.has(name) ? `\\k<${name}>` : `(?<${name}>${type.re})`;
        used.add(name);
        last = m.index! + m[0].length;
      }
      src += escapeRe(template.slice(last));
      compiled.push({ p, re: new RegExp(`^${src}$`) });
    }
  }
  return compiled;
}

function render(p: MessagePattern, groups: Record<string, string>, lang: Language): string | null {
  const pt = paramTypes();
  const params: Params = {};
  const counts: Record<string, number> = {};
  for (const [name, raw] of Object.entries(groups)) {
    const v = pt[p.params[name]].parse(raw, lang);
    if (!v) return null;
    params[name] = v.value;
    if (v.count != null) counts[name] = v.count;
  }
  let out: string;
  if (!p.plural) out = t(p.key as MessageKey, params, lang);
  else {
    const c = p.count ?? 'count';
    const count = c.startsWith('#') ? counts[c.slice(1)] : Number(groups[c]);
    if (!Number.isFinite(count)) return null;
    out = tp(p.key as PluralKey, count, params, lang);
  }
  // A list ending in an abbreviated weekday ("fös.") right before the sentence's full stop: one period, not two.
  return Object.values(p.params).some((ty) => ty === 'weekdays') ? out.replace(/(\p{L})\.\.(?=\s|$)/gu, '$1.') : out;
}

const cache: Record<Language, Map<string, string | null>> = { en: new Map(), is: new Map() };

function localizeOrNull(text: string, lang: Language): string | null {
  const c = cache[lang];
  if (c.has(text)) return c.get(text)!;
  const out = recognise(text, lang);
  if (c.size > 2000) c.clear();
  c.set(text, out);
  return out;
}

function recognise(text: string, lang: Language): string | null {
  const s = staticText(text, lang);
  if (s != null) return s;
  // A generated warm-up cue followed by the calibration cue.
  const suffix = ` ${CALIBRATION_CUE}`;
  if (text.endsWith(suffix)) {
    const head = localizeOrNull(text.slice(0, -suffix.length), lang);
    return head == null ? null : `${head} ${t('program.explain.calibrationCue', undefined, lang)}`;
  }
  for (const { p, re } of compiledPatterns()) {
    const m = re.exec(text);
    if (!m?.groups) continue;
    const out = render(p, m.groups, lang);
    if (out != null) return out;
  }
  return null;
}
