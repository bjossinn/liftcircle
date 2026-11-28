// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest';
import {
  EN, IS, calendarDateText, clockText, countCategory, decimalInput, effectiveLanguage, getLanguage, hasKey, interpolate, listText, loadText,
  numberText, setLanguage, t, tp, type MessageKey,
} from '@/i18n';
import { formatDate, formatMinutes, relativeDayLabel, weekdayLong, weekdayShort, daysAgoText } from '@/lib/dates';
import { sharedT } from '../../supabase/functions/_shared/i18n/core';

const ph = (s: string) => [...s.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g)].map((m) => m[1]).sort();

afterEach(() => setLanguage('en'));

describe('dictionaries', () => {
  const enKeys = Object.keys(EN).sort();
  const isKeys = Object.keys(IS).sort();

  it('have the same 8769 keys in English and Icelandic', () => {
    expect(enKeys).toEqual(isKeys);
    expect(enKeys).toHaveLength(8769);
  });

  it('have no empty values and the same placeholder names in both languages', () => {
    for (const k of enKeys as MessageKey[]) {
      expect(EN[k].trim(), k).not.toBe('');
      expect(IS[k].trim(), k).not.toBe('');
      expect(ph(IS[k]), k).toEqual(ph(EN[k]));
    }
  });

  it('have no empty or unnamed placeholders and no sentence fragments', () => {
    for (const k of enKeys as MessageKey[]) {
      for (const v of [EN[k], IS[k]]) {
        expect(v, k).not.toMatch(/\{\{\s*\}\}/);
        // nav.unread.* is an aria-label suffix appended to a tab name (", 3 unread"), the only intended fragment.
        if (!k.startsWith('nav.unread.')) expect(v, k).not.toMatch(/^[,;]/);
        expect(v.split('{{').length, k).toBe(v.split('}}').length);
      }
    }
  });

  it('pair every .one with an .other', () => {
    for (const k of enKeys) {
      if (k.endsWith('.one')) expect(enKeys, k).toContain(`${k.slice(0, -4)}.other`);
    }
  });

  it('use the approved terminology for core labels', () => {
    expect([IS['nav.today'], IS['nav.train'], IS['nav.coach'], IS['nav.progress'], IS['nav.profile']]).toEqual(['Í dag', 'Æfingar', 'Þjálfari', 'Framfarir', 'Prófíll']);
    expect(IS['ai.channels.human']).toBe('Þjálfun');
    expect(IS['settings.languageEnglish']).toBe('English');
    expect(IS['settings.languageIcelandic']).toBe('Íslenska');
    // The current meal UI label; the superseded "Customize first" must not exist.
    expect(Object.values(IS)).toContain('Bæta við og breyta');
    expect(Object.values(EN).some((v) => /customi[sz]e first/i.test(v))).toBe(false);
  });

  it('server-shared namespaces resolve through the Deno-safe translator too', () => {
    const tr = sharedT('is');
    expect(tr.t('aiServer.auth.signIn')).toBe('Þú þarft að skrá þig inn.');
    expect(sharedT('en').t('aiServer.auth.signIn')).toBe('You need to be signed in.');
  });
});

describe('translator', () => {
  it('follows the current language and falls back to English for unknown values', () => {
    expect(t('common.cancel')).toBe('Cancel');
    setLanguage('is');
    expect(getLanguage()).toBe('is');
    expect(t('common.cancel')).toBe('Hætta við');
    expect(document.documentElement.lang).toBe('is');
    setLanguage('fr');
    expect(getLanguage()).toBe('en');
    expect(effectiveLanguage(undefined)).toBe('en');
    expect(effectiveLanguage('is')).toBe('is');
  });

  it('chooses Icelandic count variants with plural rules (21 is singular, 11 is plural)', () => {
    setLanguage('is');
    expect(tp('format.daysAgo', 1)).toBe('fyrir 1 degi');
    expect(tp('format.daysAgo', 21)).toBe('fyrir 21 degi');
    expect(tp('format.daysAgo', 11)).toBe('fyrir 11 dögum');
    expect(tp('format.daysAgo', 0)).toBe('fyrir 0 dögum');
    setLanguage('en');
    expect(tp('format.daysAgo', 1)).toBe('1 day ago');
    expect(tp('format.daysAgo', 21)).toBe('21 days ago');
  });

  it('formats number placeholders for the language and throws on a missing placeholder or key', () => {
    expect(interpolate('Næst: {{target}}', { target: '61,25 kg' })).toBe('Næst: 61,25 kg');
    expect(interpolate('{{n}}', { n: 62.5 }, 'is')).toBe('62,5');
    expect(() => interpolate('{{target}}')).toThrow(/Missing interpolation/);
    expect(() => t('no.such.key' as MessageKey)).toThrow(/Missing translation key/);
    expect(hasKey('common.cancel')).toBe(true);
    expect(hasKey('no.such.key')).toBe(false);
  });
});

describe('formatting contract', () => {
  it('numbers and loads', () => {
    expect(numberText(62.5, 2, false, 'is')).toBe('62,5');
    expect(numberText(61.25, 2, false, 'is')).toBe('61,25');
    expect(numberText(1234.5, 2, true, 'is')).toBe('1.234,5');
    expect(numberText(-2.5, 2, false, 'is')).toBe('-2,5');
    expect(numberText(62.5, 2, false, 'en')).toBe('62.5');
    expect(loadText(61.25, 'kg', 'is')).toBe('61,25 kg');
    expect(loadText(135, 'lb', 'is')).toBe('135 lb');
  });

  it('plural categories', () => {
    for (const x of [1, 21, 31, 101]) expect(countCategory(x, 'is')).toBe('one');
    for (const x of [0, 2, 11, 111]) expect(countCategory(x, 'is')).toBe('other');
  });

  it('decimal input accepts comma and point, rejects grouped/mixed input', () => {
    expect(decimalInput('62,5')).toEqual({ kind: 'valid', value: 62.5 });
    expect(decimalInput('62.5')).toEqual({ kind: 'valid', value: 62.5 });
    expect(decimalInput('-2,5')).toEqual({ kind: 'valid', value: -2.5 });
    expect(decimalInput('1.234,5')).toEqual({ kind: 'invalid' });
    expect(decimalInput('')).toEqual({ kind: 'empty' });
  });

  it('dates, times and lists', () => {
    expect(calendarDateText('2026-11-26', undefined, 'is')).toBe('26. nóvember 2026');
    expect(() => calendarDateText('2026-02-30', undefined, 'is')).toThrow(RangeError);
    expect(clockText(Date.parse('2026-11-26T00:05:00Z'), 'Atlantic/Reykjavik', 'is')).toBe('00:05');
    expect(clockText(Date.parse('2026-11-26T12:30:00Z'), 'Atlantic/Reykjavik', 'is')).toBe('12:30');
    expect(listText(['A', 'B'], 'is')).toBe('A og B');
    expect(listText(['A', 'B'], 'en')).toBe('A and B');
  });

  it('date helpers follow the language and keep the calendar date', () => {
    setLanguage('is');
    expect(weekdayShort(1)).toBe('mán.');
    expect(weekdayLong(4)).toBe('fimmtudagur');
    expect(formatDate('2026-11-26', { day: 'numeric', month: 'long' })).toBe('26. nóvember');
    expect(formatMinutes(45 * 60)).toBe('45 mín.');
    expect(formatMinutes(65 * 60)).toBe('1 klst. 5 mín.');
    expect(relativeDayLabel('2026-11-25', '2026-11-26')).toBe('Í gær');
    expect(relativeDayLabel('2026-11-27', '2026-11-26')).toBe('Á morgun');
    expect(relativeDayLabel('2026-11-20', '2026-11-26')).toBeNull();
    expect(daysAgoText(2)).toBe('fyrir 2 dögum');
    setLanguage('en');
    expect(weekdayShort(1)).toBe('Mon');
    expect(formatDate('2026-11-26', { day: 'numeric', month: 'long' })).toBe('26 November');
    expect(formatMinutes(45 * 60)).toBe('45 min');
  });
});
