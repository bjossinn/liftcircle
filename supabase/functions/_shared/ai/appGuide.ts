/**
 * App guide for the AI coach (pure, dependency-free; shared by the ai-coach function and the app).
 *
 *  - APP_GUIDE: one compact line per main screen (path, what you do there, how to get there from the tab bar). It is
 *    put into the system prompt so "where do I turn that on?" gets a correct answer with a link. Keep it in sync with
 *    src/app/routes.tsx — tests/unit/aiAppGuide.test.ts fails when a route is neither here nor in GUIDE_IGNORED.
 *  - In-app links: the model may write [[open:/path|Button label]]. validateOpenLinks keeps at most MAX_OPEN_LINKS
 *    whose path is a guide route — param routes only with ids the server actually knows — and strips the rest.
 *    The app renders the kept links as small buttons under the message (extractOpenLinks) and navigates in-app.
 */

export interface GuideEntry {
  /** Route pattern exactly as in routes.tsx (":id" params allowed). */
  path: string;
  what: string;
  how: string;
  /** For param routes: which known ids may fill the param (validated server-side). */
  param?: 'exercise' | 'recipe' | 'completedSession';
}

export const APP_GUIDE: GuideEntry[] = [
  { path: '/', what: "Today: today's planned session (start, skip or move it), this week, nutrition snapshot", how: 'Today tab' },
  { path: '/train', what: 'Train hub: start a workout, plan, history, templates, exercises, activities', how: 'Train tab' },
  { path: '/train/program', what: 'Your program: sessions, weekly schedule, versions, edit or switch plans', how: 'Train tab → Program' },
  { path: '/train/history', what: 'Workout history', how: 'Train tab → History' },
  { path: '/train/history/:id', what: 'One past workout', how: 'Train tab → History → a workout', param: 'completedSession' },
  { path: '/train/templates', what: 'Workout templates (create, edit, start)', how: 'Train tab → Templates' },
  { path: '/train/exercises', what: 'Exercise library: search, favourites, custom exercises', how: 'Train tab → Exercises' },
  { path: '/train/exercises/:id', what: 'One exercise: how-to, history, substitutions', how: 'Train tab → Exercises → an exercise', param: 'exercise' },
  { path: '/train/activity/new', what: 'Log a run, walk, ride or other activity', how: 'Train tab → Log activity' },
  { path: '/train/intervals', what: 'Interval timer', how: 'Train tab → Interval timer' },
  { path: '/onboarding', what: 'Setup questions → a new suggested program', how: 'Settings → Redo setup questions' },
  { path: '/progress', what: 'Progress: records, charts, bodyweight and measurements', how: 'Progress tab' },
  { path: '/nutrition', what: 'Nutrition hub (only when Nutrition features is on in Settings)', how: 'Nutrition tab' },
  { path: '/nutrition/targets', what: 'Protein, calorie and macro targets', how: 'Nutrition tab → Targets, or Settings → Nutrition targets' },
  { path: '/nutrition/recipes', what: 'Recipe catalog with favourites', how: 'Nutrition tab → Recipes' },
  { path: '/nutrition/recipes/:id', what: 'One recipe: ingredients, steps, macros, log it', how: 'Nutrition tab → Recipes → a recipe', param: 'recipe' },
  { path: '/nutrition/plan', what: 'Weekly meal plan (generate, swap, balance to targets)', how: 'Nutrition tab → Meal plan' },
  { path: '/nutrition/shopping', what: 'Shopping list from the meal plan', how: 'Nutrition tab → Meal plan → Shopping list' },
  { path: '/nutrition/log', what: 'Food log (log meals, foods, quick entries)', how: 'Nutrition tab → Food log' },
  { path: '/feed', what: 'Social feed of friends’ workouts', how: 'Feed tab' },
  { path: '/feed/new', what: 'Write a post', how: 'Feed tab → New post' },
  { path: '/friends', what: 'Friends and friend requests', how: 'Feed tab → Friends' },
  { path: '/profile', what: 'Your public profile', how: 'Feed tab → your avatar' },
  { path: '/profile/edit', what: 'Edit your public profile', how: 'Profile → Edit' },
  { path: '/notifications', what: 'In-app notifications', how: 'Bell icon at the top of the main screens' },
  {
    path: '/settings',
    what: 'Settings: units, theme, week start; Workout (rest timer, warm-ups, Empty bar weight, Coach cheers during workouts); Notifications incl. Push notifications on this device; Plan & nutrition (Nutrition features toggle, Nutrition targets, Redo setup questions); Sharing & privacy (discoverable, auto-share)',
    how: 'Gear icon at the top of the main screens',
  },
  { path: '/settings/data', what: 'Your data: export, backups, import, delete account', how: 'Settings → Your data' },
  { path: '/install', what: 'Install the app on your phone (Home Screen)', how: 'Settings → Install on your phone' },
  { path: '/coaching', what: 'Coaching hub: AI coach, your human coach, find a coach', how: 'Coaching tab' },
  { path: '/coaching/find', what: 'Find a human coach', how: 'Coaching tab → Find a coach' },
  { path: '/coaching/my', what: 'Your human coach and their plan', how: 'Coaching tab → My coach' },
  { path: '/coaching/apply', what: 'Apply to become a coach', how: 'Coaching tab → Become a coach' },
  { path: '/coaching/ai', what: 'This AI coach chat', how: 'Coaching tab → AI coach' },
  { path: '/coaching/ai/setup', what: 'AI coach setup and consent', how: 'Coaching tab → AI coach → Set up' },
  { path: '/coaching/ai/settings', what: 'AI coach settings: what the AI can see (Profile, Training, Measurements, Nutrition), notes, coach style, pause', how: 'AI coach → ⋮ → Settings' },
  { path: '/coaching/ai/proposals', what: 'AI suggestions: plan changes to review and apply', how: 'AI coach → ⋮ → AI suggestions' },
];

/**
 * Routes deliberately not in the guide: admin/internal screens, auth flows, and pages that need an id the coach
 * can't know (other people, posts, coaching threads, in-progress sessions).
 */
export const GUIDE_IGNORED: string[] = [
  '*', '/auth', '/auth/callback', '/import-guest', '/moderation',
  '/coaching/admin', '/coaching/admin/reports', '/coaching/admin/:coachId', '/coaching/dashboard',
  '/coaching/client/:relationshipId', '/coaching/client/:relationshipId/program',
  '/coaching/coach/:id', '/coaching/request/:coachId', '/coaching/messages/:relationshipId', '/coaching/proposal/:id',
  '/coaching/checkin/:relationshipId', '/u/:username', '/feed/post/:id',
  '/train/session/:id', '/train/summary/:id', '/train/activity/:id',
];

export const MAX_OPEN_LINKS = 2;

/** Compact guide text for the system prompt. */
export function appGuideText(): string {
  return APP_GUIDE.map((g) => `- ${g.path} — ${g.what} (${g.how})`).join('\n');
}

export interface KnownIds {
  exercise?: Set<string>;
  recipe?: Set<string>;
  completedSession?: Set<string>;
}

const OPEN_RE = /\[\[\s*open\s*:\s*([^|\]\s]+)\s*(?:\|\s*([^\]]*?))?\s*\]\]/gi;
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

/** The guide entry a path matches (params need a known id when `known` is given; the app passes none). */
export function matchGuidePath(path: string, known?: KnownIds): GuideEntry | null {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[?#\\\s]/.test(path)) return null;
  const parts = path.split('/');
  for (const g of APP_GUIDE) {
    const gp = g.path.split('/');
    if (gp.length !== parts.length) continue;
    let ok = true;
    for (let i = 0; i < gp.length && ok; i++) {
      if (gp[i].startsWith(':')) {
        const id = decodeURIComponentSafe(parts[i]);
        ok = !!id && ID_RE.test(id) && (!known || !!(g.param && known[g.param]?.has(id)));
      } else ok = gp[i] === parts[i];
    }
    if (ok) return g;
  }
  return null;
}

function decodeURIComponentSafe(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

const cleanLabel = (l: string | undefined) => (l ?? '').replace(/[[\]|<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Open';

/**
 * Server side: keep at most MAX_OPEN_LINKS valid links (rewritten in a canonical form), remove invalid or extra ones,
 * and tidy the whitespace a removed marker leaves behind.
 */
export function validateOpenLinks(text: string, known: KnownIds): { text: string; kept: { path: string; label: string }[]; removed: number } {
  const kept: { path: string; label: string }[] = [];
  let removed = 0;
  const out = String(text ?? '').replace(OPEN_RE, (_m, rawPath: string, rawLabel?: string) => {
    const path = rawPath.trim();
    if (kept.length < MAX_OPEN_LINKS && matchGuidePath(path, known) && !kept.some((k) => k.path === path)) {
      const label = cleanLabel(rawLabel);
      kept.push({ path, label });
      return `[[open:${path}|${label}]]`;
    }
    removed++;
    return '';
  });
  return { text: removed ? out.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim() : out, kept, removed };
}

/**
 * App side: split a stored reply into the text to render and the link buttons (re-checked against the guide's
 * patterns; at most MAX_OPEN_LINKS). Markers are always removed from the displayed text.
 */
export function extractOpenLinks(text: string): { text: string; links: { path: string; label: string }[] } {
  const links: { path: string; label: string }[] = [];
  const out = String(text ?? '').replace(OPEN_RE, (_m, rawPath: string, rawLabel?: string) => {
    const path = rawPath.trim();
    if (links.length < MAX_OPEN_LINKS && matchGuidePath(path) && !links.some((l) => l.path === path)) links.push({ path, label: cleanLabel(rawLabel) });
    return '';
  });
  return { text: out.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim(), links };
}
