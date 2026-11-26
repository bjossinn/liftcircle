/**
 * Coach notifications (roadmap item 9): the 55 English and 55 Icelandic strings are used verbatim from the approved
 * dictionary (tests/unit/fixtures/coachPush.*.json): settings.* and validation.* in the client dictionaries, push.* in
 * the server-shared ones (merged into the client). Same keys, same placeholders, .one/.other pairs, and the server's
 * Deno-safe translator resolves the push fallbacks too.
 */
import { describe, expect, it } from 'vitest';
import EN_FIX from './fixtures/coachPush.en.json';
import IS_FIX from './fixtures/coachPush.is.json';
import { EN, IS, tp, type MessageKey } from '@/i18n';
import { CLIENT_EN } from '@/i18n/locales/en';
import { CLIENT_IS } from '@/i18n/locales/is';
import { SHARED_EN } from '../../supabase/functions/_shared/i18n/messages.en';
import { SHARED_IS } from '../../supabase/functions/_shared/i18n/messages.is';
import { sharedT } from '../../supabase/functions/_shared/i18n/core';

const ph = (s: string) => [...s.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g)].map((m) => m[1]).sort();
const en = EN_FIX as Record<string, string>;
const is = IS_FIX as Record<string, string>;

describe('coach notification strings', () => {
  it('has all 55 keys in both languages with the exact approved text', () => {
    expect(Object.keys(en)).toHaveLength(55);
    expect(Object.keys(is).sort()).toEqual(Object.keys(en).sort());
    for (const [k, v] of Object.entries(en)) expect(EN[k as MessageKey], k).toBe(v);
    for (const [k, v] of Object.entries(is)) expect(IS[k as MessageKey], k).toBe(v);
  });

  it('puts settings/validation keys in the client dictionaries and push keys in the server-shared ones', () => {
    for (const k of Object.keys(en)) {
      if (k.startsWith('push.')) {
        expect(SHARED_EN[k as keyof typeof SHARED_EN], k).toBe(en[k]);
        expect(SHARED_IS[k as keyof typeof SHARED_IS], k).toBe(is[k]);
        expect(k in CLIENT_EN).toBe(false);
      } else {
        expect(CLIENT_EN[k as keyof typeof CLIENT_EN], k).toBe(en[k]);
        expect(CLIENT_IS[k as keyof typeof CLIENT_IS], k).toBe(is[k]);
      }
    }
    expect(sharedT('is').t('push.coachFood.body')).toBe(is['push.coachFood.body']);
    expect(sharedT('en').t('push.coachMissed.body')).toBe(en['push.coachMissed.body']);
  });

  it('keeps placeholders and plural pairs in step', () => {
    for (const k of Object.keys(en)) expect(ph(is[k]), k).toEqual(ph(en[k]));
    for (const k of Object.keys(en).filter((x) => x.endsWith('.one'))) expect(en, k).toHaveProperty(`${k.slice(0, -4)}.other`);
    expect(tp('settings.coachPushCap', 1, undefined, 'en')).toBe('1 reminder per day');
    expect(tp('settings.coachPushCap', 3, undefined, 'is')).toBe('3 áminningar á dag');
    expect(tp('settings.coachPushSnoozeAction', 1, undefined, 'is')).toBe('Hvíla mig í 1 dag');
    expect(tp('settings.coachPushSnoozeAction', 14, undefined, 'en')).toBe('Rest me for 14 days');
    expect(tp('settings.coachPushSnoozeDays', 7, undefined, 'is')).toBe('7 dagar');
  });
});
