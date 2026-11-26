// @vitest-environment jsdom
/**
 * Icelandic training assistant chat surface (group g7a_aichat): single-step consent, channel switcher, the
 * app-rendered welcome, contextual Coach requests and chips, error mapping (never raw English), usage, and the
 * generated-text provenance helpers used when Training sharing is turned off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';

vi.mock('@/backend/supabase', () => ({ backendConfigured: false, requireSupabase: () => { throw new Error('no backend in tests'); } }));
vi.mock('@/backend/ai', () => ({ aiApi: { saveSettings: vi.fn() } }));

import { IS, listText, setLanguage } from '@/i18n';
import type { AiSettings } from '@/backend/coachingContract';
import { createProgram } from '@/domain/program/program';
import type { Exercise, ID, Program, ProgramVersion, WorkoutSession } from '@/domain/types';
import { AiConsent } from '@/features/coaching/ai/AiConsent';
import { CoachSwitcher } from '@/features/coaching/coachChannels';
import { buildWelcome } from '@/features/coaching/ai/welcome';
import {
  checkinReviewText, classifyAiError, COACH_STYLE_INFO, pendingErrorText, PROPOSAL_VIEW_LABEL, providerLabel, providerName, SCOPE_INFO, suggestedQuestions, usageLine, welcomeChips,
} from '@/features/coaching/ai/model';
import { coachRequestText, stripGenerated, trackDraftEdit, type CoachRequest } from '@/features/coaching/ai/workoutContext';
import { availabilityCopy } from '@/features/coaching/ai/parts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
function render(el: ReactElement) {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(el));
}
const buttonNamed = (name: string) => {
  const b = [...document.querySelectorAll('button')].find((x) => norm(x.getAttribute('aria-label') || x.textContent) === name);
  if (!b) throw new Error(`no button ${name}`);
  return b;
};

beforeEach(() => setLanguage('is'));
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.innerHTML = '';
  setLanguage('en');
});

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const AVAILABLE = { available: true as const, provider: 'openai' as const, providerName: 'OpenAI', consentCurrent: true };
const settingsWith = (scopes: AiSettings['scopes']): AiSettings => ({ enabled: false, paused: false, consentAt: null, scopes, profileNotes: '', coachStyle: 'supportive' });

/* ------------------------------------------------------------------ consent */
describe('single-step consent (Icelandic)', () => {
  it('all scopes off: one sentence (aiConsent.sharedNone), no duplicated “skilaboð” clause; not-shared list via Intl.ListFormat', () => {
    render(createElement(AiConsent, { availability: AVAILABLE, settings: settingsWith({ profile: false, training: false, measurements: false, nutrition: false }), onEnabled: () => undefined }));
    const body = norm(document.body.textContent);
    expect(body).toContain(IS['aiConsent.sharedNone']);
    expect(body).toContain('Aðeins skilaboðin þín og minnispunktar fyrir æfingaaðstoðina.');
    expect(body).not.toContain('Aðeins skilaboðin þín, ásamt');
    expect(body.match(/skilaboðin þín/g)).toHaveLength(1);
    expect(body).toContain(`Ekki deilt: ${listText(['prófíll og óskir', 'æfingar', 'mælingar', 'næring'], 'is')}.`);
    expect(body).not.toMatch(/ and |, plus /);
  });

  it('fresh, Supportive by default: shared categories, tone, acceptance with the provider name, and the enable button', () => {
    render(createElement(AiConsent, { availability: AVAILABLE, settings: null, onEnabled: () => undefined }));
    const body = norm(document.body.textContent);
    expect(body).toContain(`${listText(['Prófíll og óskir', 'Æfingar'], 'is')}, ásamt skilaboðunum þínum og minnispunktum fyrir æfingaaðstoðina.`);
    expect(body).toContain('Tónn: Uppörvandi (sjálfgefið)');
    expect(body).toContain('Þreyta er alltaf gild ástæða til að taka léttari æfingu eða hvíla sig.');
    expect(body).toContain('sendar frá þjóninum til OpenAI þegar þú spyrð spurningar');
    expect(buttonNamed('Kveikja á æfingaaðstoð')).toBeTruthy();
    expect(body).toContain('Hvað gerir hún?');
    expect(body).toContain('Leggur til breytingar á æfingaáætlun og dagsetningum. Ekkert breytist fyrr en þú velur Nota breytingar');
  });

  it('provider change: named notice and Agree button', () => {
    render(createElement(AiConsent, {
      availability: { ...AVAILABLE, consentCurrent: false },
      settings: { ...settingsWith({ profile: true, training: true, measurements: false, nutrition: false }), enabled: true, consentAt: '2026-11-01T10:00:00Z' },
      onEnabled: () => undefined,
    }));
    expect(norm(document.body.textContent)).toContain('Æfingaaðstoðin notar nú OpenAI í stað fyrri gervigreindarþjónustu.');
    expect(buttonNamed('Samþykkja og halda áfram')).toBeTruthy();
  });

  it('scope and style labels are localized while their IDs stay stable', () => {
    expect(SCOPE_INFO.map((s) => [s.key, s.title])).toEqual([['profile', 'Prófíll og óskir'], ['training', 'Æfingar'], ['measurements', 'Mælingar'], ['nutrition', 'Næring']]);
    expect(COACH_STYLE_INFO.map((s) => [s.key, s.title])).toEqual([['supportive', 'Uppörvandi'], ['balanced', 'Yfirvegaður'], ['strict', 'Strangur']]);
    expect(PROPOSAL_VIEW_LABEL.pending.label).toBe('Tilbúið til yfirferðar');
    setLanguage('en');
    expect(SCOPE_INFO[0].title).toBe('Profile & preferences');
  });
});

/* ------------------------------------------------------------- channel switcher */
describe('channel switcher (Icelandic)', () => {
  it('labels Æfingaaðstoð / Þjálfun, invariant unread label and retry', () => {
    render(createElement(MemoryRouter, null, createElement(CoachSwitcher, { current: 'ai', unread: 21, onRetry: () => undefined })));
    const nav = document.querySelector('nav')!;
    expect(nav.getAttribute('aria-label')).toBe('Þjálfun og æfingaaðstoð');
    const links = [...nav.querySelectorAll('a')].map((a) => norm(a.textContent));
    expect(links[0]).toBe('Æfingaaðstoð');
    expect(links[1]).toBe('Þjálfun21');
    expect(nav.querySelector('[aria-label="Ólesin skilaboð: 21"]')).not.toBeNull();
    const retry = buttonNamed('Reyna aftur að sækja upplýsingar um þjálfun');
    expect(retry.getAttribute('title')).toBe('Ekki tókst að sækja upplýsingar um þjálfunina. Reyna aftur');
  });
});

/* ------------------------------------------------------------------- welcome */
const ALL = { profile: true, training: true, measurements: false, nutrition: false };
const WED = '2026-10-28';
function plan(managedBy?: Program['managedBy']): Program {
  const tpl = (id: string, name: string) => ({ id, name, focus: name, kind: 'lifting' as const, estimatedMinutes: 45, exercises: [] });
  const v: ProgramVersion = {
    version: 1, createdAt: 0, reason: 't', templates: [tpl('A', 'Full body A'), tpl('B', 'Full body B'), tpl('C', 'Full body C')],
    schedule: [{ weekday: 1, templateId: 'A' }, { weekday: 3, templateId: 'B' }, { weekday: 5, templateId: 'C' }], weeks: 8, reviewWeek: 8, rationale: [], warnings: [],
  };
  const p = createProgram(null, v, '2026-10-05', 'Full body 3x', 'generated');
  return managedBy ? { ...p, managedBy } : p;
}
const done = (p: Program, templateId: string, date: string): WorkoutSession => ({
  id: `${templateId}${date}`, createdAt: 0, updatedAt: 0, name: templateId, status: 'completed', programId: p.id, templateId, plannedDate: date, date, timeZone: 'UTC', startedAt: 0, pausedTotalMs: 0, exercises: [],
});

describe('welcome message (Icelandic)', () => {
  it('greeting, plan sentence with localized goal and weekdays, this week, next and closing', () => {
    const p = plan();
    const w = buildWelcome({ scopes: ALL, goal: 'strength', displayName: 'Sam Smith', hour: 8, program: p, sessions: [done(p, 'A', '2026-10-26')], today: WED, weekStart: 1 });
    expect(w.greeting).toBe('Góðan morgun, Sam.');
    expect(w.lines).toEqual([
      'Markmið: auka styrk. Þú fylgir „Full body 3x“: 3 æfingar á viku (mán., mið., fös.).',
      'Þessi vika: 1 af 3 æfingum lokið (Full body A, mán.). Næst: Full body B, í dag.',
    ]);
    expect(w.closing).toBe('„Full body B“ er á dagskrá í dag. Eigum við að byrja?');
  });

  it('greetings without a name, coach-managed plans and count variants', () => {
    expect(buildWelcome({ scopes: { ...ALL, profile: false }, hour: 14, program: null, sessions: [], today: WED, weekStart: 1 }).greeting).toBe('Góðan dag.');
    expect(buildWelcome({ scopes: ALL, hour: 21, program: null, sessions: [], today: WED, weekStart: 1 }).greeting).toBe('Gott kvöld.');
    expect(buildWelcome({ scopes: ALL, program: null, sessions: [], today: WED, weekStart: 1 }).greeting).toBe('Hæ.');
    const coached = buildWelcome({ scopes: ALL, program: plan({ kind: 'coach', coachName: 'Kim' }), sessions: [], today: WED, weekStart: 1 });
    expect(coached.lines[0]).toBe('Þú fylgir „Full body 3x“ (þjálfari: Kim): 3 æfingar á viku (mán., mið., fös.).');
    const generic = buildWelcome({ scopes: ALL, program: plan({ kind: 'coach' }), sessions: [], today: WED, weekStart: 1 });
    expect(generic.lines[0]).toContain('(í umsjón þjálfarans þíns)');
    const p = plan();
    const all = buildWelcome({ scopes: ALL, program: p, sessions: [done(p, 'A', '2026-10-26'), done(p, 'B', '2026-10-28'), done(p, 'C', '2026-10-30')], today: '2026-10-31', weekStart: 1 });
    expect(all.lines[1]).toBe('Vikan er kláruð: öllum 3 æfingum á dagskrá lokið.');
    expect(all.closing).toBe('Njóttu hvíldardagsins.');
  });

  it('no plan, training not shared and missed-session tones', () => {
    expect(buildWelcome({ scopes: ALL, goal: 'lose_fat', program: null, sessions: [], today: WED, weekStart: 1 }).lines).toEqual([
      'Markmiðið þitt: minnka fitu. Þú ert ekki með virka æfingaáætlun enn. Ég get hjálpað þér að finna góðan upphafspunkt.',
    ]);
    expect(buildWelcome({ scopes: { ...ALL, training: false }, program: plan(), sessions: [], today: WED, weekStart: 1 }).lines).toEqual([IS['ai.welcome.trainingNotShared']]);
    const p = plan();
    const missed = (style: 'supportive' | 'balanced' | 'strict') => buildWelcome({ scopes: ALL, program: p, sessions: [done(p, 'A', '2026-10-26')], today: '2026-10-29', weekStart: 1, style }).lines.at(-1);
    expect(missed('supportive')).toBe('Ég sé að æfingunni „Full body B“ var ekki lokið í gær. Það er allt í lagi. Hvernig líður þér?');
    expect(missed('strict')).toBe('Á dagskránni í gær var „Full body B“ og þeirri æfingu er enn ólokið. Taktu hana í dag og byrjaðu á fyrstu tveimur æfingunum.');
  });
});

/* -------------------------------------------------------- contextual requests */
describe('contextual Coach requests and chips (Icelandic)', () => {
  const BENCH = { id: 'barbell-bench-press', name: 'Barbell bench press' } as Exercise;
  const byId = new Map<ID, Exercise>([[BENCH.id, BENCH]]);
  const session = (status: WorkoutSession['status']): WorkoutSession => ({
    id: 's1', createdAt: 0, updatedAt: 0, name: 'Push A', status, date: '2026-11-26', timeZone: 'UTC', startedAt: 0, pausedTotalMs: 0,
    exercises: [{ id: 'se-bench', exerciseId: BENCH.id, order: 0, sets: [] }],
  });
  const req = (r: Partial<CoachRequest>): CoachRequest => ({ intent: 'explain', sessionId: 's1', createdAt: 0, ...r });

  it('uses the exact aiServer.context templates; names go in unchanged; the typed intent is untouched', () => {
    const shorten = req({ intent: 'shorten', minutes: 15 });
    expect(coachRequestText(shorten, session('active'), byId)).toBe('Lítill tími: Ég hef um 15 mínútur eftir. Styttu það sem er eftir af æfingunni í dag (Push A).');
    expect(shorten.intent).toBe('shorten');
    expect(coachRequestText(req({ intent: 'swap', focusId: 'se-bench' }), session('active'), byId)).toBe(
      'Búnaður upptekinn: Ég kemst ekki í búnaðinn fyrir þessa æfingu: Barbell bench press. Hvað get ég gert í staðinn, bara í dag?',
    );
    expect(coachRequestText(req({ intent: 'swap' }), session('active'), byId)).toContain('fyrir þessa æfingu: þessa æfingu.');
    expect(coachRequestText(req({ focusId: 'se-bench', shownTarget: '62,5 kg × 8' }), session('active'), byId)).toBe(
      'Útskýrðu þetta: Af hverju leggur appið til „62,5 kg × 8“ í dag fyrir þessa æfingu: Barbell bench press?',
    );
    expect(coachRequestText(req({ focusId: 'se-bench', shownTarget: '62,5 kg × 8' }), session('completed'), byId)).toBe(
      'Útskýrðu þetta: Af hverju er næsta markmið „62,5 kg × 8“ í þessari æfingu: Barbell bench press?',
    );
    expect(coachRequestText(req({ focusId: 'se-bench' }), session('active'), byId)).toBe('Útskýrðu þetta: Hvernig ætti ég að haga þessari æfingu í dag og af hverju? Æfing: Barbell bench press.');
    expect(coachRequestText(req({}), session('completed'), byId)).toBe('Útskýrðu þetta: Hvað þýða næstu markmið eftir þessa æfingu?');
    expect(coachRequestText(req({}), session('active'), byId)).toBe('Útskýrðu þetta: Hvernig gengur æfingin í dag og að hverju ætti ég að stefna næst?');
    // English is unchanged.
    expect(coachRequestText(shorten, session('active'), byId, 'en')).toBe('Short on time: I have about 15 minutes left. Please shorten the rest of today’s workout (Push A).');
  });

  it('quick replies, suggested questions and the check-in request', () => {
    expect(welcomeChips()).toEqual(['Mér líður vel 💪', 'Smá þreyta', 'Með harðsperrur', 'Lítill tími', 'Mig langar að sleppa í dag']);
    expect(suggestedQuestions()).toEqual([
      'Ég get bara æft tvisvar í þessari viku', 'Hjálpaðu mér að bæta mig í bekkpressu', 'Stingdu upp á máltíðum sem passa við próteinmarkmiðið mitt', 'Farðu yfir síðustu tvær vikurnar mínar',
    ]);
    expect(checkinReviewText()).toBe('Farðu yfir nýlegar æfingar mínar og framfarir.');
  });
});

/* --------------------------------------------------------------------- errors */
describe('classifyAiError never shows raw English', () => {
  const cases: [unknown, string][] = [
    [{ code: 'PT429', message: 'You’ve reached today’s training assistant limit of 2 messages.' }, IS['ai.error.dailyLimit']],
    [{ code: 'consent_required', message: 'The training assistant now uses OpenAI. Review what’s sent…' }, IS['ai.error.providerChanged']],
    [{ code: 'network', message: 'Failed to fetch' }, IS['ai.error.offline']],
    [{ code: 'ai_paused', message: 'The training assistant is paused. Resume it in training assistant settings.' }, IS['ai.error.paused']],
    [{ code: 'ai_disabled', message: 'The training assistant is turned off.' }, IS['ai.error.disabled']],
    [{ code: 'ai_unavailable', reason: 'provider_down', message: 'OpenAI timed out' }, IS['ai.error.unavailable']],
    [{ code: 'backend_missing', message: 'The training assistant isn’t set up on this server.' }, IS['ai.error.notSetUp']],
    [{ code: 'auth', status: 401, message: 'JWT expired' }, IS['ai.error.auth']],
    [new Error('relation "ai_messages" does not exist'), IS['ai.error.failed']],
    [{ code: 'http_500', message: 'Internal Server Error' }, IS['ai.error.failed']],
    ['boom', IS['ai.error.failed']],
  ];
  it.each(cases)('%o', (e, expected) => {
    const c = classifyAiError(e);
    expect(c.message).toBe(expected);
    const raw = typeof e === 'string' ? e : (e as { message: string }).message;
    expect(c.message).not.toContain(raw);
    if (raw) expect(c.detail).toBe(raw); // kept for diagnostics only
  });

  it('a stored pending error shows in the app language (keys, known older English, unknown text)', () => {
    expect(pendingErrorText('ai.chat.trainingOffPending')).toBe(IS['ai.chat.trainingOffPending']);
    expect(pendingErrorText('Not confirmed yet. Tap Retry to send it again.')).toBe(IS['ai.chat.notConfirmed']);
    expect(pendingErrorText('You appear to be offline. Your message is kept. Try again when you’re connected.')).toBe(IS['ai.error.offline']);
    expect(pendingErrorText('some raw database error')).toBe(IS['ai.error.failed']);
    setLanguage('en');
    expect(pendingErrorText('some raw database error')).toBe('some raw database error');
    expect(pendingErrorText('ai.error.offline')).toBe('You appear to be offline. Your message is kept. Try again when you’re connected.');
  });

  it('usage line, provider wording and unavailable copy', () => {
    expect(usageLine({ requests: 3, limitRequests: 40 })).toBe('Notað í dag: 3 af 40 skilaboðum · 37 eftir');
    expect(usageLine({ requests: 21 })).toBe('21 skilaboð í dag');
    expect(providerName({ available: false, reason: 'offline' })).toBeUndefined();
    expect(providerLabel({ available: false, reason: 'offline' })).toBe('gervigreindarþjónustan');
    expect(providerLabel(AVAILABLE)).toBe('OpenAI');
    expect(availabilityCopy('offline')).toEqual({ title: 'Engin nettenging', body: IS['ai.unavailable.offline.body'] });
  });
});

/* ------------------------------------------------- generated-text provenance */
describe('generated-text provenance (Training-off cleanup keeps what the user wrote)', () => {
  const GEN = 'Útskýrðu þetta: Af hverju leggur appið til „62,5 kg × 8“ í dag fyrir þessa æfingu: Barbell bench press?';

  it('an edited generated prefix plus the user’s own question: only the generated detail goes', () => {
    let draft = GEN;
    let ranges: [number, number][] = [[0, GEN.length]];
    expect(trackDraftEdit('', 'Ætti ég að létta mig?', [], [GEN])).toEqual([]); // typed: the user's
    const edited = GEN.replace('Útskýrðu þetta', 'Stutt spurning');
    ranges = trackDraftEdit(draft, edited, ranges, [GEN]);
    draft = edited;
    const appended = `${draft}\nÆtti ég að létta mig?`;
    ranges = trackDraftEdit(draft, appended, ranges, [GEN]);
    expect(stripGenerated(appended, ranges, [GEN])).toBe('Stutt spurning\nÆtti ég að létta mig?');
  });

  it('text typed before the generated part stays; pasting the generated text back counts as generated', () => {
    const before = 'Hnén eru fín.\n';
    const draft = `${before}${GEN}`;
    let ranges: [number, number][] = [[before.length, draft.length]];
    expect(stripGenerated(draft, ranges, [GEN])).toBe('Hnén eru fín.');
    // The user deletes the generated text, then pastes it back (or undoes the deletion).
    ranges = trackDraftEdit(draft, before, ranges, [GEN]);
    expect(ranges).toEqual([]);
    ranges = trackDraftEdit(before, draft, ranges, [GEN]);
    expect(stripGenerated(draft, ranges, [GEN])).toBe('Hnén eru fín.');
  });
});
