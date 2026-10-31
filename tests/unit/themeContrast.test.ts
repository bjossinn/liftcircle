/**
 * WCAG AA contrast for both themes, computed from the real tokens in src/styles.css (parsed, so a palette edit can't
 * slip through). Text pairs need 4.5:1; UI components and focus indicators need 3:1 (WCAG 1.4.3 / 1.4.11).
 * Translucent "soft" fills are composited over the surface they sit on, as the browser would.
 */
import { describe, expect, it } from 'vitest';
import { THEME_META_COLOR } from '@/theme/theme';
// Vitest blanks CSS imports (even ?raw), so read the stylesheet from disk. The app tsconfig has no Node types.
// @ts-ignore
import { readFileSync } from 'node:fs';
import html from '../../index.html?raw';

const css: string = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');


function block(selectorStart: string): Record<string, string> {
  const i = css.indexOf(selectorStart);
  if (i < 0) throw new Error(`no block ${selectorStart}`);
  const body = css.slice(css.indexOf('{', i) + 1, css.indexOf('\n}', i));
  return Object.fromEntries([...body.matchAll(/--c-([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}
const THEMES = {
  Midnight: block(":root,\n[data-theme='dark']"),
  Daylight: block("[data-theme='light'] {"),
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
  const l = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * l(r) + 0.7152 * l(g) + 0.0722 * l(b);
};
const ratio = (a: RGBA, b: RGBA) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const SURFACES = ['bg', 'surface', 'surface-2', 'surface-3'];
// Every text colour used on the page, card and input surfaces.
const TEXT = ['text', 'muted', 'faint', 'accent', 'accent-2', 'celebrate', 'streak', 'danger', 'warn', 'info'];
// Coloured text on its own soft fill (badges, chips, notices, tinted icon tiles), on a card.
const ON_SOFT: [string, string][] = [
  ['accent', 'accent-soft'], ['accent-2', 'accent-2-soft'], ['celebrate', 'celebrate-soft'], ['streak', 'streak-soft'],
  ['danger', 'danger-soft'], ['warn', 'warn-soft'], ['text', 'accent-soft'], ['text', 'warn-soft'], ['text', 'danger-soft'],
];

describe.each(Object.entries(THEMES))('%s theme meets WCAG AA', (_name, t) => {
  const c = (k: string) => {
    if (!t[k]) throw new Error(`missing --c-${k}`);
    return parse(t[k]);
  };

  it.each(TEXT.flatMap((fg) => SURFACES.map((bg) => [fg, bg])))('text %s on %s ≥ 4.5:1', (fg, bg) => {
    expect(ratio(c(fg), c(bg))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(ON_SOFT)('%s on %s (over a card) ≥ 4.5:1', (fg, soft) => {
    const bg = over(c(soft), c('surface'));
    expect(ratio(c(fg), bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('primary buttons: accent-ink on accent and on accent-strong (hover) ≥ 4.5:1', () => {
    expect(ratio(c('accent-ink'), c('accent'))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(c('accent-ink'), c('accent-strong'))).toBeGreaterThanOrEqual(4.5);
  });

  it('danger button hover: page colour on danger ≥ 4.5:1', () => {
    expect(ratio(c('bg'), c('danger'))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['bg', 'surface', 'surface-2'])('UI components on %s: input borders and the accent (focus ring, switches, checks) ≥ 3:1', (bg) => {
    expect(ratio(c('input-border'), c(bg))).toBeGreaterThanOrEqual(3);
    expect(ratio(c('accent'), c(bg))).toBeGreaterThanOrEqual(3);
  });
});

describe('theme plumbing', () => {
  it('the status-bar colour of each theme is its page background', () => {
    expect(THEME_META_COLOR.dark).toBe(THEMES.Midnight.bg);
    expect(THEME_META_COLOR.light).toBe(THEMES.Daylight.bg);
  });

  it('both themes define the same tokens (nothing silently falls back to Midnight)', () => {
    expect(Object.keys(THEMES.Daylight).sort()).toEqual(Object.keys(THEMES.Midnight).sort());
  });

  it('index.html paints the same status-bar colours before React starts', () => {
    expect(html).toContain(`'${THEME_META_COLOR.light}' : '${THEME_META_COLOR.dark}'`);
    expect(html).toContain(`<meta name="theme-color" content="${THEME_META_COLOR.dark}" />`);
  });
});
