/**
 * Hard Earned colours, checked against the brand kit. src/styles.css is parsed, so a palette edit can't slip through.
 * 1. Every app token that maps to a kit role has exactly the kit's value (brand/hard-earned/hard-earned-tokens.css,
 *    as recorded in contrast-matrix.json → palettes), in both themes.
 * 2. Every pair the kit approves (contrast-matrix.json, usage_status "approved") passes its threshold with the app's
 *    values, and the kit's rejected uses are not how the app pairs colours (no chalk label on ember; light-theme accent
 *    text is the dark ember ink, never raw ember).
 * 3. App pairs the kit doesn't list pass WCAG AA: text 4.5:1, UI components and focus 3:1 (1.4.3 / 1.4.11).
 *    Translucent soft fills are composited over the card they sit on, as the browser would.
 */
import { describe, expect, it } from 'vitest';
import { THEME_META_COLOR } from '@/theme/theme';
// Vitest blanks CSS imports (even ?raw), so read files from disk. The app tsconfig has no Node types.
// @ts-ignore
import { readFileSync } from 'node:fs';
import html from '../../index.html?raw';

const css: string = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
interface MatrixPair { theme: 'dark' | 'light'; foreground_token: string; background_token: string; foreground_hex: string; background_hex: string; minimum: number; usage_status: string; purpose: string }
const matrix: { palettes: Record<'dark' | 'light', Record<string, string>>; pairs: MatrixPair[] } = JSON.parse(
  readFileSync(new URL('../../brand/hard-earned/contrast-matrix.json', import.meta.url), 'utf8'),
);

function block(selectorStart: string): Record<string, string> {
  const i = css.indexOf(selectorStart);
  if (i < 0) throw new Error(`no block ${selectorStart}`);
  const body = css.slice(css.indexOf('{', i) + 1, css.indexOf('\n}', i));
  return Object.fromEntries([...body.matchAll(/--c-([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}
const THEMES = { dark: block(":root,\n[data-theme='dark']"), light: block("[data-theme='light'] {") };

/** App token → kit role. */
const KIT_ROLE: Record<string, string> = {
  bg: 'canvas',
  surface: 'surface',
  'surface-2': 'raised',
  field: 'field',
  text: 'text',
  muted: 'text_secondary',
  faint: 'text_muted',
  border: 'border_subtle',
  'input-border': 'border_control',
  accent: 'accent_ink',
  ember: 'accent',
  'ember-hover': 'accent_hover',
  'ember-pressed': 'accent_pressed',
  'accent-ink': 'on_accent',
  'accent-soft': 'selected_surface',
  disabled: 'disabled_surface',
  'disabled-ink': 'disabled_text',
  focus: 'focus',
  success: 'success',
  danger: 'error',
  warn: 'warning',
  info: 'info',
  'danger-fill': 'danger_fill',
  'danger-fill-hover': 'danger_hover',
  'danger-fill-pressed': 'danger_pressed',
  'on-danger': 'on_danger',
  'chart-1': 'chart_1',
  'chart-2': 'chart_2',
  'chart-3': 'chart_3',
  'chart-4': 'chart_4',
  'chart-5': 'chart_5',
};

type RGBA = [number, number, number, number];
function parse(c: string): RGBA {
  const hex = c.match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1) as RGBA;
  const rgba = c.match(/^rgba?\(([^)]+)\)$/);
  if (rgba) {
    const [r, g, b, a = '1'] = rgba[1].split(',').map((x) => x.trim());
    return [Number(r), Number(g), Number(b), Number(a)];
  }
  throw new Error(`unparsed colour ${c}`);
}
const over = (fg: RGBA, bg: RGBA): RGBA => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1) as RGBA;
const lum = ([r, g, b]: RGBA) => {
  const l = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * l(r) + 0.7152 * l(g) + 0.0722 * l(b);
};
const ratio = (a: RGBA, b: RGBA) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

describe.each(['dark', 'light'] as const)('%s theme matches the Hard Earned kit', (theme) => {
  const t = THEMES[theme];
  const c = (k: string) => {
    if (!t[k]) throw new Error(`missing --c-${k}`);
    return parse(t[k]);
  };
  const appHexFor = (kitRole: string): string | undefined => {
    const app = Object.entries(KIT_ROLE).find(([, r]) => r === kitRole)?.[0];
    return app ? t[app] : undefined;
  };

  it.each(Object.entries(KIT_ROLE))('--c-%s equals the kit role %s', (app, kit) => {
    expect(t[app]?.toLowerCase(), app).toBe(matrix.palettes[theme][kit].toLowerCase());
  });

  it('the primary-button outline (edge) is charcoal, as the kit specifies', () => {
    expect(t.edge.toLowerCase()).toBe('#17191b');
  });

  const approved = matrix.pairs.filter((p) => p.theme === theme && p.usage_status === 'approved');
  it('the kit lists approved pairs for this theme', () => expect(approved.length).toBeGreaterThan(50));
  it.each(approved.map((p) => [`${p.foreground_token} on ${p.background_token} (${p.purpose})`, p] as const))('approved: %s', (_n, p) => {
    const fg = appHexFor(p.foreground_token) ?? p.foreground_hex;
    const bg = appHexFor(p.background_token) ?? p.background_hex;
    expect(ratio(parse(fg), parse(bg))).toBeGreaterThanOrEqual(p.minimum);
  });

  it('rejected uses stay unused: labels on ember are charcoal, never chalk; light accent text is dark ember ink', () => {
    expect(ratio(parse('#F3EFE7'), c('ember'))).toBeLessThan(4.5); // why chalk is rejected
    expect(t['accent-ink'].toLowerCase()).toBe('#17191b');
    if (theme === 'light') expect(t.accent.toLowerCase()).toBe('#a93623');
    for (const p of matrix.pairs.filter((x) => x.theme === theme && x.usage_status === 'rejected'))
      expect(ratio(parse(p.foreground_hex), parse(p.background_hex)), `${p.foreground_token} on ${p.background_token}`).toBeLessThan(p.minimum);
  });

  // App pairs beyond the kit's list.
  const SURFACES = ['bg', 'surface', 'surface-2', 'surface-3', 'field'];
  const TEXT = ['text', 'muted', 'faint', 'accent', 'accent-2', 'celebrate', 'streak', 'danger', 'warn', 'info', 'success'];
  it.each(TEXT.flatMap((fg) => SURFACES.map((bg) => [fg, bg])))('text %s on %s ≥ 4.5:1', (fg, bg) => {
    expect(ratio(c(fg), c(bg))).toBeGreaterThanOrEqual(4.5);
  });

  const ON_SOFT: [string, string][] = [
    ['accent', 'accent-soft'], ['text', 'accent-soft'], ['accent-2', 'accent-2-soft'], ['celebrate', 'celebrate-soft'], ['streak', 'streak-soft'],
    ['danger', 'danger-soft'], ['warn', 'warn-soft'], ['success', 'success-soft'], ['text', 'warn-soft'], ['text', 'danger-soft'], ['text', 'success-soft'],
  ];
  it.each(ON_SOFT)('%s on %s (over a card) ≥ 4.5:1', (fg, soft) => {
    expect(ratio(c(fg), over(c(soft), c('surface')))).toBeGreaterThanOrEqual(4.5);
  });

  it('labels on fills: primary (rest, hover, pressed), destructive, disabled, completed sets ≥ 4.5:1', () => {
    for (const fill of ['ember', 'ember-hover', 'ember-pressed']) expect(ratio(c('accent-ink'), c(fill)), fill).toBeGreaterThanOrEqual(4.5);
    for (const fill of ['danger-fill', 'danger-fill-hover', 'danger-fill-pressed']) expect(ratio(c('on-danger'), c(fill)), fill).toBeGreaterThanOrEqual(4.5);
    expect(ratio(c('disabled-ink'), c('disabled'))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(c('bg'), c('success'))).toBeGreaterThanOrEqual(4.5); // ✓ on a completed set / finished day
  });

  it.each(['bg', 'surface', 'surface-2', 'surface-3'])('UI components on %s: control boundary, focus outline and chart series ≥ 3:1', (bg) => {
    expect(ratio(c('input-border'), c(bg))).toBeGreaterThanOrEqual(3);
    expect(ratio(c('focus'), c(bg))).toBeGreaterThanOrEqual(3);
    for (const s of [1, 2, 3, 4, 5]) expect(ratio(c(`chart-${s}`), c(bg)), `chart-${s}`).toBeGreaterThanOrEqual(3);
  });

  it('the 2 px charcoal outline separates the ember fill from its surroundings ≥ 3:1', () => {
    expect(ratio(c('edge'), c('ember'))).toBeGreaterThanOrEqual(3);
  });
});

describe('theme plumbing', () => {
  it('the status-bar colour of each theme is its page background', () => {
    expect(THEME_META_COLOR.dark).toBe(THEMES.dark.bg);
    expect(THEME_META_COLOR.light).toBe(THEMES.light.bg);
  });

  it('both themes define the same tokens (nothing silently falls back to dark)', () => {
    expect(Object.keys(THEMES.light).sort()).toEqual(Object.keys(THEMES.dark).sort());
  });

  it('index.html paints the same status-bar colours before React starts', () => {
    expect(html).toContain(`'${THEME_META_COLOR.light}' : '${THEME_META_COLOR.dark}'`);
    expect(html).toContain(`<meta name="theme-color" content="${THEME_META_COLOR.dark}" />`);
  });
});
