/**
 * Roadmap item 11: the approved copy is used VERBATIM. docs/specs/item11-spec-and-copy.md is the committed, unmodified
 * spec; this test parses it on its own (it does not trust the fixtures) and checks, byte for byte, the 158 English and
 * 158 Icelandic entries against the fixtures (tests/unit/fixtures/item11Copy.*.json) and CLIENT_EN / CLIENT_IS, plus
 * dictionary key parity and per-key placeholder parity.
 */
import { describe, expect, it } from 'vitest';
// The app tsconfig has no Node types.
// @ts-ignore
import { readFileSync } from 'node:fs';
import EN_FIX from './fixtures/item11Copy.en.json';
import IS_FIX from './fixtures/item11Copy.is.json';
import { EN, IS, tp, t, type MessageKey } from '@/i18n';
import { CLIENT_EN } from '@/i18n/locales/en';
import { CLIENT_IS } from '@/i18n/locales/is';

const SPEC: string = readFileSync(new URL('../../docs/specs/item11-spec-and-copy.md', import.meta.url), 'utf8');
const bytes = (s: string) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');
const ph = (s: string) => [...s.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g)].map((m) => m[1]).sort();

/** The two flat JSON objects of section 6 (a line `{` up to the next line `}`), English first. */
function specDictionaries(): [Record<string, string>, Record<string, string>] {
  const lines = SPEC.split('\n');
  const out: Record<string, string>[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== '{') continue;
    const j = lines.indexOf('}', i);
    out.push(JSON.parse(lines.slice(i, j + 1).join('\n')) as Record<string, string>);
    i = j;
  }
  expect(out).toHaveLength(2);
  return [out[0], out[1]];
}

const [SPEC_EN, SPEC_IS] = specDictionaries();
const UPDATED = ['progress.emptyTitle', 'progress.emptyHelp', 'progress.consistencySummary', 'progress.proteinTrend'];
const cEN = CLIENT_EN as Record<string, string>;
const cIS = CLIENT_IS as Record<string, string>;

describe('item 11 copy (158 EN + 158 IS, verbatim)', () => {
  it('the spec has 158 entries per language with identical keys (154 new + 4 updated)', () => {
    expect(Object.keys(SPEC_EN)).toHaveLength(158);
    expect(Object.keys(SPEC_IS)).toEqual(Object.keys(SPEC_EN));
    for (const k of UPDATED) expect(k in SPEC_EN, k).toBe(true);
  });

  it('fixtures are byte-identical to the spec', () => {
    expect(EN_FIX).toEqual(SPEC_EN);
    expect(IS_FIX).toEqual(SPEC_IS);
    for (const k of Object.keys(SPEC_EN)) {
      expect(bytes((EN_FIX as Record<string, string>)[k]), k).toBe(bytes(SPEC_EN[k]));
      expect(bytes((IS_FIX as Record<string, string>)[k]), k).toBe(bytes(SPEC_IS[k]));
    }
  });

  it('CLIENT_EN / CLIENT_IS and the merged dictionaries hold every value byte for byte', () => {
    for (const k of Object.keys(SPEC_EN)) {
      expect(bytes(cEN[k] ?? ''), k).toBe(bytes(SPEC_EN[k]));
      expect(bytes(cIS[k] ?? ''), k).toBe(bytes(SPEC_IS[k]));
      expect(EN[k as MessageKey], k).toBe(SPEC_EN[k]);
      expect(IS[k as MessageKey], k).toBe(SPEC_IS[k]);
    }
  });

  it('keeps full key parity and per-key placeholder parity', () => {
    expect(Object.keys(cIS).sort()).toEqual(Object.keys(cEN).sort());
    for (const k of Object.keys(SPEC_EN)) expect(ph(SPEC_IS[k]), k).toEqual(ph(SPEC_EN[k]));
    for (const k of Object.keys(cEN)) expect(ph(cIS[k]), k).toEqual(ph(cEN[k]));
  });

  it('preserves the main Icelandic values of the two summaries', () => {
    expect(SPEC_IS['progress.consistencySummary']).toBe('Æfingar: {{workouts}} · önnur hreyfing: {{activities}} · vikur: {{weeks}}. Æfingar á viku að meðaltali: {{average}}.');
  });

  it('renders representative EN/IS output with locale numbers and Intl plural rules (1/11/21)', () => {
    expect(t('foodLog.quickProtein.add', { grams: 30 }, 'en')).toBe('Add 30 g protein');
    expect(t('foodLog.quickProtein.add', { grams: 30 }, 'is')).toBe('Skrá 30 g af próteini');
    expect(t('progress.proteinTrendWithoutTarget', { logged: 3, average: 42.5, noData: 2 }, 'is')).toBe(
      'Dagar með próteinskráningu: 3. Meðaltal á þeim dögum: 42,5 g. Dagar án próteingilda: 2.',
    );
    expect(tp('foodLog.itemCount', 1, undefined, 'en')).toBe('1 item');
    expect(tp('foodLog.itemCount', 2, undefined, 'en')).toBe('2 items');
    expect(tp('foodLog.itemCount', 21, undefined, 'is')).toBe('21 færsla');
    expect(tp('foodLog.itemCount', 11, undefined, 'is')).toBe('11 færslur');
    expect(tp('foodLog.recipes.estimate', 1, undefined, 'is')).toContain('gefur 1 skammt.');
  });
});
