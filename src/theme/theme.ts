/**
 * Themes: Hard Earned dark (the flagship) and light, plus "Match my phone".
 *
 * The stored setting (Settings.theme, synced with the account) keeps its original values, so older app versions
 * and existing accounts need no migration: 'dark' = Dark, 'light' = Light, 'system' = Match my phone.
 * `theme` is optional since 0.8.0. A missing value means "not chosen yet": new accounts start without one and follow
 * this device's choice, else Match my phone. There is no first-launch picker (removed to cut first-run friction);
 * the choice lives in Settings → Appearance.
 *
 * This device also remembers the choice (`lc-theme-choice`). That covers two cases:
 * - an account that doesn't have a theme yet (a new account, a guest, the demo) uses the device's choice;
 * - the inline script in index.html paints the right theme before React starts (`lc-theme-applied`).
 */
import type { Settings } from '@/domain/types';
import { t as translate, type MessageKey } from '@/i18n';

export type ThemeChoice = NonNullable<Settings['theme']>;
export type ResolvedTheme = 'dark' | 'light';

/** Label and description are read in the current language each time they're used. */
const themeOption = (value: ThemeChoice, labelKey: MessageKey, descriptionKey: MessageKey) => ({
  value,
  get label() {
    return translate(labelKey);
  },
  get description() {
    return translate(descriptionKey);
  },
});
export const THEME_OPTIONS: readonly { readonly value: ThemeChoice; readonly label: string; readonly description: string }[] = [
  themeOption('dark', 'settings.themeDark', 'settings.themeDarkHelp'),
  themeOption('light', 'settings.themeLight', 'settings.themeLightHelp'),
  themeOption('system', 'settings.themeSystem', 'settings.themeSystemHelp'),
];
export const themeLabel = (t: ThemeChoice) => THEME_OPTIONS.find((o) => o.value === t)?.label ?? translate('settings.themeDark');

/** Status-bar / PWA theme-color per theme. Equal to each theme's --c-bg (checked in themeContrast.test.ts). */
export const THEME_META_COLOR: Record<ResolvedTheme, string> = { dark: '#17191b', light: '#f3efe7' };

const CHOICE_KEY = 'lc-theme-choice';
const APPLIED_KEY = 'lc-theme-applied';

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
