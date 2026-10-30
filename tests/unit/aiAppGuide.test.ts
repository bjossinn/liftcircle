/**
 * App guide for the AI coach (supabase/functions/_shared/ai/appGuide.ts): every route in src/app/routes.tsx is either
 * in the guide or explicitly ignored, and [[open:/path|Label]] links are validated (server) and extracted (app).
 */
import { describe, expect, it } from 'vitest';
import ROUTES_SRC from '../../src/app/routes.tsx?raw';
import {
  APP_GUIDE, appGuideText, extractOpenLinks, GUIDE_IGNORED, matchGuidePath, MAX_OPEN_LINKS, validateOpenLinks,
} from '../../supabase/functions/_shared/ai/appGuide';

const routePaths = [...ROUTES_SRC.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1]);

describe('app guide coverage', () => {
  it('routes.tsx is parsed (sanity)', () => {
    expect(routePaths.length).toBeGreaterThan(40);
    expect(routePaths).toContain('/coaching/ai/settings');
  });

  it('every route is in the guide or in the explicit ignore list', () => {
    const covered = new Set([...APP_GUIDE.map((g) => g.path), ...GUIDE_IGNORED]);
    const missing = routePaths.filter((p) => !covered.has(p));
    expect(missing, `Add these routes to APP_GUIDE (or GUIDE_IGNORED for admin/internal ones): ${missing.join(', ')}`).toEqual([]);
  });

  it('the guide has no stale entries (each one is a real route) and covers the required screens', () => {
    const real = new Set(routePaths);
    expect(APP_GUIDE.filter((g) => !real.has(g.path)).map((g) => g.path)).toEqual([]);
    for (const p of [
      '/', '/train', '/train/program', '/train/history', '/train/templates', '/train/exercises', '/train/activity/new', '/train/intervals', '/progress',
      '/nutrition/targets', '/nutrition/recipes', '/nutrition/plan', '/nutrition/shopping', '/nutrition/log', '/feed', '/friends', '/profile',
      '/notifications', '/settings', '/settings/data', '/coaching', '/coaching/find', '/coaching/ai/settings', '/coaching/ai/proposals', '/install',
    ])
      expect(APP_GUIDE.some((g) => g.path === p), p).toBe(true);
    const settings = APP_GUIDE.find((g) => g.path === '/settings')!.what;
    for (const w of ['Coach cheers', 'Empty bar', 'Push notifications', 'Nutrition features', 'Sharing & privacy']) expect(settings).toContain(w);
  });

  it('is compact: about one line per screen', () => {
    const text = appGuideText();
    expect(text.split('\n')).toHaveLength(APP_GUIDE.length);
    expect(text.length).toBeLessThan(6000);
  });
});

describe('in-app links', () => {
  const known = { exercise: new Set(['barbell-squat']), recipe: new Set(['greek-yogurt-bowl']), completedSession: new Set(['s-1']) };

  it('server keeps valid paths, strips unknown ones and keeps at most 2', () => {
    const r = validateOpenLinks(
      'Set them here:\n[[open:/nutrition/targets|Set your targets]]\n[[open:/admin/secret|Hack]]\n[[open:/settings|Open Settings]]\n[[open:/progress|Progress]]',
      known,
    );
    expect(r.kept).toEqual([
      { path: '/nutrition/targets', label: 'Set your targets' },
      { path: '/settings', label: 'Open Settings' },
    ]);
    expect(r.removed).toBe(2);
    expect(r.text).not.toContain('/admin');
    expect(r.text).not.toContain('/progress');
    expect(MAX_OPEN_LINKS).toBe(2);
  });

  it('param routes need an id the server knows; external, protocol-relative, query and traversal paths are refused', () => {
    expect(validateOpenLinks('[[open:/train/exercises/barbell-squat|Squat]]', known).kept).toHaveLength(1);
    expect(validateOpenLinks('[[open:/train/exercises/made-up|X]]', known).kept).toHaveLength(0);
    expect(validateOpenLinks('[[open:/nutrition/recipes/greek-yogurt-bowl|Bowl]]', known).kept).toHaveLength(1);
    expect(validateOpenLinks('[[open:/train/history/s-1|Workout]]', known).kept).toHaveLength(1);
    expect(validateOpenLinks('[[open:/train/session/abc|Start]]', known).kept).toHaveLength(0); // not in the guide
    for (const bad of ['https://evil.example', '//evil.example', '/settings?x=1', '/settings#a', '/../settings', 'javascript:alert(1)'])
      expect(validateOpenLinks(`[[open:${bad}|x]]`, known).kept, bad).toHaveLength(0);
    expect(matchGuidePath('/coaching/ai/settings')).not.toBeNull();
  });

  it('labels are cleaned and limited; a missing label becomes "Open"', () => {
    const r = validateOpenLinks('[[open:/settings]] [[open:/progress|<b>Very long label that keeps going and going</b>]]', known);
    expect(r.kept[0].label).toBe('Open');
    expect(r.kept[1].label).not.toMatch(/[<>]/);
    expect(r.kept[1].label.length).toBeLessThanOrEqual(40);
  });

  it('app side: markers are removed from the text and become ≤ 2 buttons', () => {
    const { text, links } = extractOpenLinks('I can’t see your nutrition yet.\n[[open:/coaching/ai/settings|Change what the coach can see]]\n[[open:/nowhere|X]]');
    expect(text).toBe('I can’t see your nutrition yet.');
    expect(links).toEqual([{ path: '/coaching/ai/settings', label: 'Change what the coach can see' }]);
  });
});
