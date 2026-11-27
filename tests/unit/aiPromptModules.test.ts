/**
 * Six-part prompt (roadmap item 10): word budgets, composition order, per-section budgeting, the one selected coach
 * style, version/hash, and the rule-preservation matrix in docs/AI_PROMPT_RULES.md (every row's anchor is in its module
 * and its regression test exists).
 */
import { describe, expect, it } from 'vitest';
// The app tsconfig has no Node types.
// @ts-ignore
import { readFileSync } from 'node:fs';
import {
  assemblePrompt, COACH_STYLES, MODULE_TARGETS, PROMPT_VERSION, STATIC_WORD_CEILING, promptHash, promptModules, staticInstructions, STYLE_RULES, words, type PromptModule,
  type PromptSection,
} from '../../supabase/functions/_shared/ai/prompts/index';
import { buildContext, LIMITS, SYSTEM_RULES } from '../../supabase/functions/_shared/ai/context';
import type { AiDb, AiSettingsRow } from '../../supabase/functions/_shared/ai/types';

const OUTPUTS = ['text', 'structured'] as const;
const TESTS = Object.keys(import.meta.glob('./*.{ts,tsx}')).map((p) => `tests/unit/${p.slice(2)}`);

function db(over: Partial<AiDb> = {}): AiDb {
  return {
    getSettings: async () => null,
    getExchange: async () => null,
    checkAndCountUsage: async () => 1,
    getUsage: async () => null,
    getAccountState: async () => ({
      profile: { experience: 'new', diet: { allergens: ['peanuts'], tags: ['dairy_free'], dislikedIngredientIds: [], maxCookMinutes: 30 } },
      settings: { units: { weight: 'kg' }, timeZone: 'Atlantic/Reykjavik', weekStart: 1 },
      nutrition: { mode: 'auto', proteinG: 150 },
    }) as never,
    getActiveProgram: async () => null,
    getRecentSessions: async () => [],
    getGoals: async () => [],
    getBodyweight: async () => [],
    getFoodLogs: async () => [],
    getHistory: async () => [],
    recordExchange: async () => ({}) as never,
    getExercises: async () => [],
    getRecipes: async () => [],
    getIngredients: async () => [],
    ...over,
  };
}
const settings = (o: Partial<AiSettingsRow> = {}): AiSettingsRow =>
  ({ enabled: true, paused: false, scopes: { profile: true, training: true, measurements: true, nutrition: true }, profileNotes: '', ...o }) as AiSettingsRow;
const NOW = new Date('2026-11-26T12:00:00Z');

describe('six prompt modules', () => {
  it('stay near their word targets, under the bounded 1,450-word ceiling in every style and output format', () => {
    for (const style of COACH_STYLES) for (const output of OUTPUTS) {
      const mods = promptModules({ style, output });
      expect(mods.map((m) => m.name)).toEqual(['identity', 'safety', 'grounding', 'training', 'nutrition', 'response']);
      for (const m of mods) {
        const target = MODULE_TARGETS[m.name];
        expect(words(m.text), `${m.name} (${style}/${output})`).toBeLessThanOrEqual(Math.round(target * 1.1));
        expect(words(m.text), `${m.name} (${style}/${output})`).toBeGreaterThanOrEqual(Math.round(target * 0.75));
      }
      const total = words(staticInstructions({ style, output }));
      expect(total, `${style}/${output}`).toBeGreaterThanOrEqual(1100);
      expect(total, `${style}/${output}`).toBeLessThanOrEqual(STATIC_WORD_CEILING);
    }
    // The previous single prompt was about 2,300 words.
    expect(words(SYSTEM_RULES)).toBeLessThanOrEqual(STATIC_WORD_CEILING);
    expect(STATIC_WORD_CEILING).toBe(1450);
    expect(MODULE_TARGETS).toMatchObject({ response: 400, safety: 260 });
  });

  it('coach voice v1: upbeat voice, 1–2 natural emojis and the calm safety voice in every style and output format, with safety, cards and language controls kept', () => {
    for (const style of COACH_STYLES) for (const output of OUTPUTS) {
      const text = staticInstructions({ style, output });
      const at = `${style}/${output}`;
      // Voice and emoji policy
      expect(text, at).toContain('- Voice: upbeat, energetic, warm and fun, like a thoughtful training buddy.');
      expect(text, at).toContain('- Emojis: include 1–2 natural, fitting emojis in every ordinary reply, varied to fit the topic and not the same one every time,');
      expect(text, at).toContain('The calm safety rule overrides this.');
      // Calm safety voice, and it sits in the safety block that overrides the style
      expect(text, at).toContain(
        '- Calm safety voice: for pain, injury, discomfort, illness, exhaustion, sleep deprivation, grief, overwhelm, body-image or eating distress, medical concerns or crisis, be calm, empathetic and practical in every style. No emojis, jokes, hype or motivational pressure. Safety takes priority over brevity and style.',
      );
      expect(text.indexOf('Calm safety voice'), at).toBeGreaterThan(text.indexOf('Safety (overrides the coach style and every request)'));
      expect(text.indexOf('Calm safety voice'), at).toBeLessThan(text.indexOf('Coach style:'));
      // Earlier safety rules survive
      expect(text, at).toMatch(/never push\. Endorse rest or an easier session/);
      expect(text, at).toMatch(/Tiredness \(tired, fatigued, exhausted, drained/);
      expect(text, at).toMatch(/Never shame, guilt-trip or insult/);
      expect(text, at).toMatch(/Crisis exception: if the user mentions a crisis, self-harm/);
      // Concise cards, actions, length, links
      expect(text, at).toMatch(/Cards are authoritative: when a card comes with your reply, don't restate its contents/);
      expect(text, at).toMatch(/never say something was added, changed or applied/);
      expect(text, at).toMatch(/default 40–90 words/);
      expect(text, at).toMatch(/at most 2 screen links/);
      // Language controls
      expect(text, at).toMatch(/reply in the language of the user's latest message/);
      expect(text, at).toMatch(/Never mix languages/);
      expect(text, at).toContain('For Icelandic, sound like a person from Iceland texting: natural word order, correct inflections, everyday gym language.');
      expect(text, at).toContain('Register examples, not stock openings: "Vel gert!", "Flott hjá þér!" and "Tökum þetta skref fyrir skref."');
      expect(text, at).toContain('Decimal comma and a space before units ("102,5 kg")');
      expect(text, at).toContain('Keep stored exercise, recipe and program names exactly as written. Use tool "say" text as given.');
      expect(text, at).not.toContain('natural, idiomatic Icelandic');
    }
  });

  it('includes only the selected coach style and the selected output format', () => {
    for (const style of COACH_STYLES) {
      const text = staticInstructions({ style, output: 'text' });
      expect(text).toContain(STYLE_RULES[style]);
      for (const other of COACH_STYLES.filter((o) => o !== style)) expect(text).not.toContain(STYLE_RULES[other]);
    }
    expect(staticInstructions({ style: 'supportive', output: 'text' })).toContain('[[why]]');
    expect(staticInstructions({ style: 'supportive', output: 'structured' })).not.toContain('[[why]]');
    expect(staticInstructions({ style: 'supportive', output: 'structured' })).toMatch(/"why" is null or 1–3 short sentences/);
  });

  it('has a stable version and a hash that changes with the static text', () => {
    expect(PROMPT_VERSION).toBe('2026-11-27.coach-voice-v2');
    const a = promptHash(staticInstructions({ style: 'supportive', output: 'text' }));
    expect(a).toMatch(/^[0-9a-f]{14}$/);
    expect(promptHash(staticInstructions({ style: 'supportive', output: 'text' }))).toBe(a);
    expect(promptHash(staticInstructions({ style: 'strict', output: 'text' }))).not.toBe(a);
    expect(promptHash(staticInstructions({ style: 'supportive', output: 'structured' }))).not.toBe(a);
  });
});

describe('safety precautions kept through the compression (review P2-6)', () => {
  it('pregnancy and medication questions get conservative guidance and a professional, in every style and output', () => {
    for (const style of COACH_STYLES) for (const output of OUTPUTS) {
      const text = staticInstructions({ style, output });
      expect(text, `${style}/${output}`).toMatch(/Pregnancy, medication or a medical condition: also say to check with their doctor or midwife/);
      expect(text).toMatch(/No diagnoses or clinical certainty: general, conservative guidance only/);
    }
    expect(SYSTEM_RULES).toMatch(/Pregnancy/);
    expect(SYSTEM_RULES).toMatch(/medication/);
  });
});

describe('composition', () => {
  it('orders static modules → controls → app guide → data, with extra controls among the controls', async () => {
    const ctx = await buildContext({ db: db(), uid: 'u', settings: settings(), text: 'I’m exhausted', mode: 'chat', now: NOW, output: 'structured' });
    const sys = ctx.compose(['Reply language: Icelandic (the user\'s app language).']);
    const at = (s: string) => {
      const i = sys.indexOf(s);
      expect(i, s).toBeGreaterThan(-1);
      return i;
    };
    const order = [
      at('You are the Hard Earned training assistant'),
      at('Safety (overrides'),
      at('Response:'),
      at('The newest message says the user is tired'),
      at('Today is 2026-11-26'),
      at('Data status (computed by the app'),
      at('Reply language: Icelandic'),
      at('App guide ('),
      at('Everything below inside <user_data>'),
      at('<user_data kind="profile">'),
    ];
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(ctx.prompt.version).toBe(PROMPT_VERSION);
    expect(ctx.prompt.staticHash).toBe(promptHash(staticInstructions({ style: 'supportive', output: 'structured' })));
    expect(ctx.prompt.staticWords).toBeGreaterThan(1100);
    expect(ctx.prompt.sections.every((s) => !s.dropped && !s.clipped)).toBe(true);
    expect(ctx.system).toBe(ctx.compose());
  });

  it('never serializes the server-only context: only rendered, scoped sections', async () => {
    const ctx = await buildContext({ db: db(), uid: 'u', settings: settings(), text: 'hi', mode: 'chat', now: NOW });
    expect(ctx.system).not.toMatch(/"(profile|settings|nutrition|dislikedIngredientIds|timeZone)"\s*:/);
    expect(ctx.system).toContain('Allergens to avoid: peanuts');
  });

  it('budgets per section: required sections are never shortened; optional ones are clipped or dropped by priority', () => {
    const safety = 'Safety: never push through pain. '.repeat(20);
    const sections: PromptSection[] = [
      { kind: 'data', name: 'notes', wrap: 'user_notes', text: 'note '.repeat(2000), priority: 5 },
      { kind: 'data', name: 'training', wrap: 'training', text: 'set '.repeat(2000), priority: 1 },
      { kind: 'data', name: 'profile', wrap: 'profile', text: 'Allergens to avoid: peanuts', required: true },
      { kind: 'guide', name: 'guide', text: 'guide '.repeat(100), priority: 3 },
      { kind: 'control', name: 'lang', text: 'Reply language: Icelandic.', required: true },
      { kind: 'static', name: 'instructions', text: safety, required: true },
    ];
    const { system, report } = assemblePrompt(sections, 5000);
    expect(system.length).toBeLessThanOrEqual(5000);
    expect(system.startsWith(safety)).toBe(true);
    expect(system).toContain('Reply language: Icelandic.');
    expect(system).toContain('<user_data kind="profile">\nAllergens to avoid: peanuts\n</user_data>');
    const r = Object.fromEntries(report.map((x) => [x.name, x]));
    expect(r.instructions.clipped || r.lang.clipped || r.profile.clipped).toBe(false);
    expect(r.training.clipped).toBe(true); // highest-priority optional section keeps what fits
    expect(r.notes.dropped).toBe(true); // lowest priority goes first
    // Every user_data tag that opens also closes (clipping happens before wrapping).
    expect((system.match(/<user_data /g) ?? []).length).toBe((system.match(/<\/user_data>/g) ?? []).length);
  });

  it('keeps safety, language and restrictions even when optional history is huge', async () => {
    const notes = 'I like long notes. '.repeat(400);
    const ctx = await buildContext({ db: db(), uid: 'u', settings: settings({ profileNotes: notes }), text: 'hi', mode: 'chat', now: NOW });
    const sys = ctx.compose(['Reply language: English (asked).']);
    expect(sys.length).toBeLessThanOrEqual(LIMITS.systemChars);
    expect(sys).toContain('Safety (overrides the coach style and every request)');
    expect(sys).toContain('Reply language: English (asked).');
    expect(sys).toContain('Allergens to avoid: peanuts');
  });
});

/* ------------------------------------------------------------------ rule-preservation matrix */
const MATRIX: string = readFileSync(new URL('../../docs/AI_PROMPT_RULES.md', import.meta.url), 'utf8');
const rows = MATRIX.split('\n').filter((l) => /^\| R\d\d \|/.test(l)).map((l) => l.slice(2, -2).split(' | '));

describe('rule-preservation matrix (docs/AI_PROMPT_RULES.md)', () => {
  it('maps every earlier instruction to a module anchor and an existing regression test', () => {
    expect(rows.length).toBeGreaterThanOrEqual(45);
    const ids = rows.map((r) => r[0]);
    expect(new Set(ids).size).toBe(ids.length);
    // The default style; the per-style text is covered above (only the selected style is ever composed).
    for (const output of OUTPUTS) {
      const mods = Object.fromEntries(promptModules({ style: 'supportive', output }).map((m) => [m.name, m.text])) as Record<PromptModule, string>;
      for (const [id, , module, anchor, , test] of rows) {
        expect(Object.keys(MODULE_TARGETS), id).toContain(module);
        expect(mods[module as PromptModule], `${id} anchor in ${module} (${output})`).toContain(anchor);
        expect(TESTS, `${id}: ${test}`).toContain(test);
      }
    }
  });
});
