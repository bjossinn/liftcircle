/**
 * Themes: Hard Earned dark (the flagship) and light, plus "Match my phone".
 *
 * The stored setting (Settings.theme, synced with the account) keeps its original values, so older app versions
 * and existing accounts need no migration: 'dark' = Dark, 'light' = Light, 'system' = Match my phone.
 * `theme` is optional since 0.8.0. A missing value means "not chosen yet": new accounts start without one, and the
 * first-launch picker (ThemePicker.tsx) asks for it.
 *
 * This device also remembers the choice (`lc-theme-choice`). That covers two cases:
 * - an account that doesn't have a theme yet (a new account, a guest, the demo) uses the device's choice;
 * - the inline script in index.html paints the right theme before React starts (`lc-theme-applied`).
 */
import type { Settings } from '@/domain/types';

export type ThemeChoice = NonNullable<Settings['theme']>;
export type ResolvedTheme = 'dark' | 'light';

export const THEME_OPTIONS: { value: ThemeChoice; label: string; description: string }[] = [
  { value: 'dark', label: 'Dark', description: 'Charcoal with ember accents' },
  { value: 'light', label: 'Light', description: 'Chalk with ember accents' },
  { value: 'system', label: 'Match my phone', description: 'Follows your phone’s light or dark mode' },
];
export const themeLabel = (t: ThemeChoice) => THEME_OPTIONS.find((o) => o.value === t)?.label ?? 'Dark';

/** Status-bar / PWA theme-color per theme. Equal to each theme's --c-bg (checked in themeContrast.test.ts). */
export const THEME_META_COLOR: Record<ResolvedTheme, string> = { dark: '#17191b', light: '#f3efe7' };

const CHOICE_KEY = 'lc-theme-choice';
const APPLIED_KEY = 'lc-theme-applied';
/** Written by versions before 0.8.0 on every launch: its presence means this device has used the app before. */
const LEGACY_KEY = 'lc-theme';
/** Set when the first-launch picker's Continue is tapped. */
export const PICKED_KEY = 'lc-theme-picked';

const ls = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode etc.: the theme still applies for this visit */
    }
  },
};

const isChoice = (v: unknown): v is ThemeChoice => v === 'dark' || v === 'light' || v === 'system';

export function deviceThemeChoice(): ThemeChoice | null {
  const v = ls.get(CHOICE_KEY);
  return isChoice(v) ? v : null;
}
export function setDeviceThemeChoice(t: ThemeChoice) {
  ls.set(CHOICE_KEY, t);
}

/** The account's choice wins; otherwise this device's; otherwise Match system. */
export function effectiveThemeChoice(accountTheme: Settings['theme'] | undefined, device = deviceThemeChoice()): ThemeChoice {
  return isChoice(accountTheme) ? accountTheme : (device ?? 'system');
}

export function systemPrefersLight(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches;
  } catch {
    return false;
  }
}
export function resolveTheme(t: ThemeChoice, prefersLight = systemPrefersLight()): ResolvedTheme {
  return t === 'system' ? (prefersLight ? 'light' : 'dark') : t;
}

let fadeTimer: ReturnType<typeof setTimeout> | undefined;
/** Apply a resolved theme to the page: tokens, status-bar colour, and the pre-paint hint for the next launch. */
export function applyTheme(resolved: ResolvedTheme, opts: { fade?: boolean } = {}) {
  const root = document.documentElement;
  if (root.dataset.theme === resolved) return;
  if (opts.fade) {
    root.classList.add('theme-fade');
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => root.classList.remove('theme-fade'), 220);
  }
  root.dataset.theme = resolved;
  ls.set(APPLIED_KEY, resolved);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_META_COLOR[resolved]);
}

/** Calls `onChange` when the phone switches between light and dark (for Match system). */
export function watchSystemTheme(onChange: () => void): () => void {
  try {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  } catch {
    return () => {};
  }
}

export function themePickedOnDevice(): boolean {
  return ls.get(PICKED_KEY) === '1' || ls.get(LEGACY_KEY) != null;
}
export function markThemePicked() {
  ls.set(PICKED_KEY, '1');
}

export interface ThemePickerInput {
  /** Continue was tapped on this device, or this device used the app before 0.8.0. */
  pickedOnDevice: boolean;
  /** The account row has been read (or is known to be empty). */
  accountReady: boolean;
  /** The account's synced theme (undefined = never chosen). */
  accountTheme: Settings['theme'] | undefined;
  isDemo: boolean;
  /** Current pathname: sign-in and import screens are never covered. */
  path: string;
}
/**
 * Show "Pick your look" only on a first launch: nothing picked on this device, and no theme in the account's synced
 * settings (an existing account, or a sign-in on a new device, already has one). Never in the demo, and never over
 * the sign-in, auth callback or guest-import screens.
 */
export function shouldShowThemePicker(i: ThemePickerInput): boolean {
  if (i.pickedOnDevice || i.isDemo || !i.accountReady) return false;
  if (isChoice(i.accountTheme)) return false;
  return !/^\/(auth|import-guest)(\/|$)/.test(i.path);
}
