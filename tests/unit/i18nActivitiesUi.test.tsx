// @vitest-environment jsdom
/**
 * Icelandic activities and push copy: the activity form and interval timer render the approved Icelandic labels,
 * activity validation messages follow the current language (with the type noun inside the sentence), and push texts
 * are built from the dictionary in the given language.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ app: null as unknown }));
vi.mock('@/state/app', () => ({ useApp: () => h.app }));

import { ToastProvider } from '@/components/toast';
import ActivityFormPage from '@/features/activities/ActivityFormPage';
import IntervalTimerPage from '@/features/activities/IntervalTimerPage';
import { LanguageProvider, setLanguage } from '@/i18n';
import { defaultAccountState } from '@/state/defaults';
import { LiftDb } from '@/db/db';
import { activityLabel, validateActivity } from '@/domain/activities';
import { missedText, reminderText, restText } from '@/domain/pushSchedule';

let root: Root | null = null;
let el: HTMLElement | null = null;
let n = 0;

async function render(page: () => ReturnType<typeof createElement>, url: string) {
  const account = defaultAccountState();
  h.app = { account, db: new LiftDb(`i18n-activities-${++n}`), auth: { status: 'signed_out' }, online: true };
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  await act(async () =>
    root!.render(
      createElement(ToastProvider, null, createElement(MemoryRouter, { initialEntries: [url] }, createElement(LanguageProvider, { language: 'is', children: createElement(page) }))),
    ),
  );
  await act(async () => new Promise((r) => setTimeout(r, 50)));
}
const text = () => document.body.textContent?.replace(/\s+/g, ' ') ?? '';

afterEach(() => {
  act(() => root?.unmount());
  el?.remove();
  root = null;
  setLanguage('en');
});

describe('activities in Icelandic', () => {
  it('activity form renders Icelandic labels', async () => {
    await render(ActivityFormPage, '/train/activity/new');
    const s = text();
    expect(s).toContain('Skrá hreyfingu');
    expect(s).toContain('Byrja út frá sniðmáti');
    expect(s).toContain('Vista hreyfingu');
    expect(s).toContain('Orka (valfrjálst)');
    expect(s).not.toContain('Save activity');
  });

  it('interval timer renders Icelandic labels and default step names', async () => {
    await render(IntervalTimerPage, '/train/intervals');
    const s = text();
    expect(s).toContain('Lotutímamælir');
    expect(s).toContain('Hver umferð');
    expect(s).toContain('Bæta við skrefi');
    expect(s).toMatch(/Byrja · /);
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Heiti skrefs 1"]')?.value).toBe('Átak');
  });

  it('validation messages and the custom fallback follow the language', () => {
    setLanguage('is');
    const r = validateActivity({ type: 'hike', date: '2026-11-01', durationSec: 600, distanceM: 400_000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.distanceM).toBe('Þessi vegalengd virðist of löng fyrir fjallgöngu');
    const d = validateActivity({ type: 'run', date: '2026-11-01', durationSec: 10 });
    if (!d.ok) expect(d.errors.durationSec).toBe('Tímalengd verður að vera að minnsta kosti 1 mínúta');
    expect(activityLabel({ type: 'custom' })).toBe('Sérsniðin hreyfing');
    setLanguage('en');
    const e = validateActivity({ type: 'hike', date: '2026-11-01', durationSec: 600, distanceM: 400_000 });
    if (!e.ok) expect(e.errors.distanceM).toBe('That distance looks too long for a hike');
  });

  it('push texts use the dictionary in the given language', () => {
    expect(reminderText('Efri A', 'strict', 'is')).toBe('Efri A í dag. Byrjaðu á fyrstu æfingunni.');
    expect(missedText('Efri A', 'supportive', 'is')).toMatch(/^Efri A er enn ólokið frá í gær/);
    expect(restText('Bekkpressa', 3, '60 kg × 8', 'is')).toBe('Hvíld lokið: Bekkpressa lota 3, 60 kg × 8');
    expect(restText('Bench press', 2, '', 'en')).toBe('Rest’s up: Bench press set 2');
  });
});
