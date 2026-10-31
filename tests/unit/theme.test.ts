// @vitest-environment jsdom
/**
 * Theme logic (src/theme/theme.ts): when the first-launch picker shows, which choice applies (account → device →
 * Match system), legacy devices, and the planned-week streak on Today (src/domain/program/streak.ts).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  effectiveThemeChoice, markThemePicked, resolveTheme, setDeviceThemeChoice, deviceThemeChoice, shouldShowThemePicker, themeLabel, themePickedOnDevice,
  type ThemePickerInput,
} from '@/theme/theme';
import { plannedWeekStreak } from '@/domain/program/streak';
import { createProgram } from '@/domain/program/program';
import type { ProgramVersion, SessionTemplate, WorkoutSession } from '@/domain/types';
import { addDays } from '@/lib/dates';

beforeEach(() => localStorage.clear());

const base: ThemePickerInput = { pickedOnDevice: false, accountReady: true, accountTheme: undefined, isDemo: false, path: '/' };

describe('shouldShowThemePicker', () => {
  it('a brand-new user (nothing on this device, no theme in the account) sees it, on any first route', () => {
    expect(shouldShowThemePicker(base)).toBe(true);
    expect(shouldShowThemePicker({ ...base, path: '/onboarding' })).toBe(true);
    expect(shouldShowThemePicker({ ...base, path: '/train' })).toBe(true);
  });

  it('an existing user with a theme in their settings never sees it (old values count: dark, light, system)', () => {
    for (const t of ['dark', 'light', 'system'] as const) expect(shouldShowThemePicker({ ...base, accountTheme: t })).toBe(false);
  });

  it('a signed-in user whose synced account has a theme (new device) is not asked again', () => {
    expect(shouldShowThemePicker({ ...base, accountTheme: 'light', path: '/' })).toBe(false);
  });

  it('never in the demo, never before the account row is read, never over sign-in or import screens', () => {
    expect(shouldShowThemePicker({ ...base, isDemo: true })).toBe(false);
    expect(shouldShowThemePicker({ ...base, accountReady: false })).toBe(false);
    for (const path of ['/auth', '/auth/callback', '/import-guest']) expect(shouldShowThemePicker({ ...base, path })).toBe(false);
    expect(shouldShowThemePicker({ ...base, path: '/authors' })).toBe(true); // only real auth routes are excluded
  });

  it('after Continue on this device it never shows again; closing before Continue shows it again', () => {
    expect(themePickedOnDevice()).toBe(false);
    setDeviceThemeChoice('light'); // tapping a card alone doesn't mark it done
    expect(themePickedOnDevice()).toBe(false);
    markThemePicked();
    expect(themePickedOnDevice()).toBe(true);
    expect(shouldShowThemePicker({ ...base, pickedOnDevice: themePickedOnDevice() })).toBe(false);
  });

  it('a device that used the app before 0.8.0 (legacy lc-theme key) counts as picked', () => {
    localStorage.setItem('lc-theme', 'dark');
    expect(themePickedOnDevice()).toBe(true);
  });
});

describe('effective theme', () => {
  it('the account wins, then this device, then Match system', () => {
    expect(effectiveThemeChoice('dark', 'light')).toBe('dark');
    expect(effectiveThemeChoice(undefined, 'light')).toBe('light');
    expect(effectiveThemeChoice(undefined, null)).toBe('system');
  });

  it('guest/demo/new accounts without a theme use the device choice saved by the picker', () => {
    setDeviceThemeChoice('light');
    expect(deviceThemeChoice()).toBe('light');
    expect(effectiveThemeChoice(undefined)).toBe('light');
  });

  it('Match system follows the phone; names map from the stored values', () => {
    expect(resolveTheme('system', true)).toBe('light');
    expect(resolveTheme('system', false)).toBe('dark');
    expect(resolveTheme('dark', true)).toBe('dark');
    expect([themeLabel('dark'), themeLabel('light'), themeLabel('system')]).toEqual(['Midnight', 'Daylight', 'Match system']);
  });
});

describe('planned-week streak', () => {
  // 2026-11-02 is a Monday; the program starts then with Mon/Wed/Fri sessions.
  const MON = '2026-11-02';
  const lift = (id: string): SessionTemplate => ({ id, name: id, focus: id, kind: 'lifting', exercises: [], estimatedMinutes: 45 });
  const v: ProgramVersion = {
    version: 1, createdAt: 0, reason: 'test', templates: [lift('A'), lift('B'), lift('C')], weeks: 12, reviewWeek: 12, rationale: [], warnings: [],
    schedule: [{ weekday: 1, templateId: 'A' }, { weekday: 3, templateId: 'B' }, { weekday: 5, templateId: 'C' }],
  };
  const p = createProgram(null, v, MON, 'Test', 'generated');
  const done = (templateId: string, date: string): WorkoutSession => ({
    id: `s-${templateId}-${date}`, createdAt: 0, updatedAt: 0, name: templateId, status: 'completed', templateId, date, plannedDate: date, programId: p.id, timeZone: 'UTC',
    startedAt: Date.parse(date), pausedTotalMs: 0, exercises: [],
  });
  const fullWeek = (from: string) => [done('A', from), done('B', addDays(from, 2)), done('C', addDays(from, 4))];

  it('counts consecutive fully completed weeks; the current week joins only once it is complete', () => {
    const sessions = [...fullWeek(MON), ...fullWeek(addDays(MON, 7))];
    const wed3 = addDays(MON, 16); // Wednesday of week 3, Monday done
    expect(plannedWeekStreak(p, [...sessions, done('A', addDays(MON, 14))], [], wed3, 1)).toBe(2);
    const sun3 = addDays(MON, 20);
    expect(plannedWeekStreak(p, [...sessions, ...fullWeek(addDays(MON, 14))], [], sun3, 1)).toBe(3);
  });

  it('a missed session breaks it; no program means no streak', () => {
    const sessions = [...fullWeek(MON), done('A', addDays(MON, 7)), done('C', addDays(MON, 11))];
    expect(plannedWeekStreak(p, sessions, [], addDays(MON, 15), 1)).toBe(0);
    expect(plannedWeekStreak(null, [], [], MON, 1)).toBe(0);
  });

  it('weeks before the program started do not count', () => {
    expect(plannedWeekStreak(p, fullWeek(MON), [], addDays(MON, 8), 1)).toBe(1);
  });
});
