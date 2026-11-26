/**
 * Roadmap item 10: the approved copy is used VERBATIM. docs/specs/item10-spec-and-copy.md is the committed, unmodified
 * spec; this test parses it on its own (it does not trust the generated fixtures) and checks, byte for byte:
 *  - the 27 English and 27 Icelandic chat/streaming strings: fixtures (tests/unit/fixtures/aiStreaming.*.json), the client
 *    dictionaries (ai.chat.* / ai.error.*) and the server-shared ones (aiServer.error.*), all placeholder-free;
 *  - the 15 English and 15 Icelandic eval prompts and the seeded case-13 request/blocked reply in tests/evals/coach.cases.json.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import EN_FIX from './fixtures/aiStreaming.en.json';
import IS_FIX from './fixtures/aiStreaming.is.json';
import CASES from '../evals/coach.cases.json';
import { EN, IS, type MessageKey } from '@/i18n';
import { CLIENT_EN } from '@/i18n/locales/en';
import { CLIENT_IS } from '@/i18n/locales/is';
import { SHARED_EN } from '../../supabase/functions/_shared/i18n/messages.en';
import { SHARED_IS } from '../../supabase/functions/_shared/i18n/messages.is';
import { sharedT } from '../../supabase/functions/_shared/i18n/core';

const SPEC = readFileSync(new URL('../../docs/specs/item10-spec-and-copy.md', import.meta.url), 'utf8');
const bytes = (s: string) => Buffer.from(s, 'utf8').toString('hex');

/** The two dictionary code blocks, in order (English, then Icelandic). */
function specDictionaries(): [Record<string, string>, Record<string, string>] {
  const blocks = SPEC.split('```json\n').slice(1).map((b) => b.slice(0, b.indexOf('\n```')));
  const dicts = blocks.map((b) => JSON.parse(b) as Record<string, string>).filter((d) => 'ai.chat.stopReply' in d);
  expect(dicts).toHaveLength(2);
  return [dicts[0], dicts[1]];
}

/** Rows of the markdown table that follows `heading`: [id, category, prompt, criteria]. */
function specRows(heading: string): string[][] {
  const lines = SPEC.slice(SPEC.indexOf(heading)).split('\n');
  const table: string[] = [];
  for (const l of lines.slice(1)) {
    if (l.startsWith('|')) table.push(l);
    else if (table.length) break;
  }
  return table.slice(2).map((l) => l.replace(/^\| /, '').replace(/ \|$/, '').split(' | '));
}

const [SPEC_EN, SPEC_IS] = specDictionaries();
const en = EN_FIX as Record<string, string>;
const is = IS_FIX as Record<string, string>;

describe('item 10 dictionary (27 EN + 27 IS, verbatim)', () => {
  it('fixtures are byte-identical to the spec', () => {
    expect(Object.keys(SPEC_EN)).toHaveLength(27);
    expect(Object.keys(SPEC_IS)).toEqual(Object.keys(SPEC_EN));
    expect(en).toEqual(SPEC_EN);
    expect(is).toEqual(SPEC_IS);
    for (const k of Object.keys(SPEC_EN)) {
      expect(bytes(en[k]), k).toBe(bytes(SPEC_EN[k]));
      expect(bytes(is[k]), k).toBe(bytes(SPEC_IS[k]));
    }
  });

  it('routes ai.chat.* / ai.error.* to the client and aiServer.error.* to the server dictionaries, exactly', () => {
    const client = Object.keys(SPEC_EN).filter((k) => k.startsWith('ai.chat.') || k.startsWith('ai.error.'));
    const server = Object.keys(SPEC_EN).filter((k) => k.startsWith('aiServer.error.'));
    expect(client).toHaveLength(24);
    expect(server).toHaveLength(3);
    for (const k of client) {
      expect(bytes(CLIENT_EN[k as keyof typeof CLIENT_EN]), k).toBe(bytes(SPEC_EN[k]));
      expect(bytes(CLIENT_IS[k as keyof typeof CLIENT_IS]), k).toBe(bytes(SPEC_IS[k]));
      expect(k in SHARED_EN, k).toBe(false);
    }
    for (const k of server) {
      expect(bytes(SHARED_EN[k as keyof typeof SHARED_EN]), k).toBe(bytes(SPEC_EN[k]));
      expect(bytes(SHARED_IS[k as keyof typeof SHARED_IS]), k).toBe(bytes(SPEC_IS[k]));
      expect(sharedT('is').t(k as never)).toBe(SPEC_IS[k]);
      expect(k in CLIENT_EN, k).toBe(false);
    }
    // The merged app dictionaries resolve every key to the approved text.
    for (const k of Object.keys(SPEC_EN)) {
      expect(EN[k as MessageKey], k).toBe(SPEC_EN[k]);
      expect(IS[k as MessageKey], k).toBe(SPEC_IS[k]);
    }
  });

  it('is placeholder-free and keeps the existing reused strings', () => {
    for (const v of [...Object.values(SPEC_EN), ...Object.values(SPEC_IS)]) expect(v).not.toMatch(/\{\{/);
    expect(EN['aiCard.mealPlan.addEdit' as MessageKey]).toBe('Add and edit');
    expect(IS['aiCard.mealPlan.addEdit' as MessageKey]).toBe('Bæta við og breyta');
  });
});

describe('item 10 eval set (15 EN + 15 IS prompts, verbatim)', () => {
  const cases = CASES.cases as { id: string; lang: string; prompt: string; category: string; criteria: string }[];

  it('has 30 cases whose prompts and criteria match the spec tables byte for byte', () => {
    const rows = [...specRows('**English cases**'), ...specRows('**Icelandic cases — copy verbatim**')];
    expect(rows).toHaveLength(30);
    expect(cases).toHaveLength(30);
    rows.forEach(([id, category, prompt, criteria], i) => {
      const c = cases[i];
      expect(c.id).toBe(id);
      expect(c.lang).toBe(id.slice(0, 2).toLowerCase());
      expect(c.category).toBe(category);
      expect(bytes(c.prompt), id).toBe(bytes(prompt));
      expect(c.criteria).toBe(criteria);
    });
    expect(cases.filter((c) => c.lang === 'is').map((c) => c.id)).toEqual(Array.from({ length: 15 }, (_, i) => `IS${String(i + 1).padStart(2, '0')}`));
  });

  it('seeds case 13 with the exact request and blocked reply', () => {
    const quoted = (label: string, section: string) => {
      const part = SPEC.slice(SPEC.indexOf(section));
      return part.slice(part.indexOf(`- **${label}:** “`) + `- **${label}:** “`.length).split('”\n')[0];
    };
    const s = CASES.seeds.blockedMealPlan;
    expect(bytes(s.en.request)).toBe(bytes(quoted('EN', 'seed these exact requests')));
    expect(bytes(s.is.request)).toBe(bytes(quoted('IS', 'seed these exact requests')));
    expect(bytes(s.en.blocked)).toBe(bytes(quoted('EN', 'Seed a blocked assistant response')));
    expect(bytes(s.is.blocked)).toBe(bytes(quoted('IS', 'Seed a blocked assistant response')));
    expect(s.is.request).toBe('Gerðu matseðil fyrir næstu viku með tveimur máltíðum á dag, án fisks og jarðhneta.');
  });

  it('freezes the domain clock as specified', () => {
    expect(CASES.clock).toEqual({ now: '2026-11-26T12:00:00Z', timeZone: 'Atlantic/Reykjavik', weekStart: 1 });
  });
});
