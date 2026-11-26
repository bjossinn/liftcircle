/**
 * App guide for the training assistant (pure, dependency-free; shared by the ai-coach function and the app).
 *
 *  - APP_GUIDE: one compact line per main screen (path, what you do there, how to get there). The app has four tabs —
 *    Today, Train, Coach, Progress (plus Feed when the social feed is switched on) — and a Profile icon in the header
 *    that leads to Nutrition, Friends and Settings. The guide goes into the system prompt so "where do I turn that on?"
 *    gets a correct answer with a link. Keep it in sync with src/app/routes.tsx — tests/unit/aiAppGuide.test.ts fails
 *    when a route is neither here nor in GUIDE_IGNORED.
 *  - Feature flags: entries tagged with a flag (the coach marketplace, the social feed) are left out of the prompt and
 *    their links are refused while that area is switched off, so the assistant never sends people to a hidden screen.
 *    The app reads its flags from Vite env (src/config/featureFlags.ts); the ai-coach function reads the same names
 *    without the VITE_ prefix from its env (guideFeaturesFromEnv). Both default to off.
 *  - In-app links: the model may write [[open:/path|Button label]]. validateOpenLinks keeps at most MAX_OPEN_LINKS
 *    screen links and MAX_RECIPE_LINKS recipe links whose path is a guide route — param routes only with ids the server
 *    actually knows (an unknown recipe id is stripped) — strips the rest and cleans the lines they leave dangling.
 *    The app renders the kept links as small buttons under the message (extractOpenLinks) and navigates in-app.
 */

/** Product areas behind a feature flag (same names as the app's src/config/featureFlags.ts). */
export type GuideFlag = 'coachMarketplace' | 'socialFeed';
export type GuideFeatures = Partial<Record<GuideFlag, boolean>>;

export interface GuideEntry {
  /** Route pattern exactly as in routes.tsx (":id" params allowed). */
  path: string;
  what: string;
  how: string;
  /** For param routes: which known ids may fill the param (validated server-side). */
  param?: 'exercise' | 'recipe' | 'completedSession';
  /** Only in the guide (and linkable) when this area is switched on. */
  flag?: GuideFlag;
}

const PROFILE = 'Profile icon (top right of the main screens)';
const NUTRITION = `Today → Nutrition card or quick action, or ${PROFILE} → Nutrition`;

export const APP_GUIDE: GuideEntry[] = [
  { path: '/', what: "Today: today's planned session (start, skip or move it), this week, protein/nutrition card, quick actions", how: 'Today tab' },
  { path: '/train', what: 'Train hub: start a workout, plan, history, templates, exercises, activities', how: 'Train tab' },
  { path: '/train/program', what: 'Your program: sessions, weekly schedule, versions, edit or switch plans', how: 'Train tab → Program' },
  { path: '/train/history', what: 'Workout history', how: 'Train tab → History' },
  { path: '/train/history/:id', what: 'One past workout', how: 'Train tab → History → a workout', param: 'completedSession' },
  { path: '/train/templates', what: 'Workout templates (create, edit, start)', how: 'Train tab → Templates' },
  { path: '/train/exercises', what: 'Exercise library: search, favourites, custom exercises', how: 'Train tab → Exercises' },
  { path: '/train/exercises/:id', what: 'One exercise: how-to, history, substitutions', how: 'Train tab → Exercises → an exercise', param: 'exercise' },
  { path: '/train/activity/new', what: 'Log a run, walk, ride or other activity', how: 'Train tab → Log activity, or Today → Log activity' },
  { path: '/train/intervals', what: 'Interval timer', how: 'Train tab → Interval timer' },
  { path: '/onboarding', what: 'Six setup questions (goal, experience, days, session length, where you train, areas to be careful with) → a new suggested program', how: `${PROFILE} → Settings → Redo setup questions` },
  { path: '/progress', what: 'Progress: records, charts, bodyweight and body measurements', how: 'Progress tab' },
  { path: '/nutrition', what: 'Nutrition hub (optional; turn on with Nutrition features in Settings)', how: NUTRITION },
  { path: '/nutrition/targets', what: 'Protein, calorie and macro targets', how: 'Nutrition → Targets, or Settings → Nutrition targets' },
  { path: '/nutrition/recipes', what: 'Recipe catalog with favourites', how: 'Nutrition → Recipes' },
  { path: '/nutrition/recipes/:id', what: 'One recipe: ingredients, steps, macros, log it', how: 'Nutrition → Recipes → a recipe', param: 'recipe' },
  { path: '/nutrition/plan', what: 'Weekly meal plan (generate, swap, balance to targets)', how: 'Nutrition → Meal plan' },
  { path: '/nutrition/shopping', what: 'Shopping list from the meal plan', how: 'Nutrition → Meal plan → Shopping list' },
  { path: '/nutrition/log', what: 'Food log (log meals, foods, quick entries)', how: 'Today → Nutrition card → Log food, or Nutrition → Food log' },
  { path: '/feed', what: 'Social feed of friends’ workouts', how: 'Feed tab', flag: 'socialFeed' },
  { path: '/feed/new', what: 'Share a workout as a post', how: 'Workout summary → Share' },
  { path: '/friends', what: 'Friends and friend requests', how: `${PROFILE} → Friends` },
  { path: '/profile', what: 'Your profile, with links to Nutrition, Friends and Settings', how: PROFILE },
  { path: '/profile/edit', what: 'Edit your public profile', how: 'Profile → Edit profile' },
  { path: '/notifications', what: 'In-app notifications', how: 'Bell icon at the top of the main screens' },
  {
    path: '/settings',
    what: 'Settings: units, theme, week start; Workout (rest timer, warm-ups, Empty bar weight, Coach cheers during workouts); Notifications incl. Push notifications on this device; Plan & nutrition (Nutrition features toggle, Nutrition targets, Redo setup questions); Sharing & privacy (discoverable, auto-share)',
    how: `${PROFILE} → Settings`,
  },
  { path: '/settings/data', what: 'Your data: export, backups, import, delete account', how: 'Settings → Your data' },
  { path: '/install', what: 'Install the app on your phone (Home Screen)', how: 'Settings → Install on your phone' },
  { path: '/coach', what: 'Coach tab: this training assistant chat', how: 'Coach tab' },
  { path: '/coaching', what: 'Human coaching: your coach, past coaching, coach workspace and applications', how: 'Coach tab → Coaching (shown when you have or had a coach, or coach yourself)' },
  { path: '/coaching/find', what: 'Find a human coach', how: 'Coach tab → Coaching → Look for a coach', flag: 'coachMarketplace' },
  { path: '/coaching/my', what: 'Your human coach and their plan', how: 'Coach tab → Coaching → My coach' },
  { path: '/coaching/apply', what: 'Apply to become a coach', how: 'Coach tab → Coaching → Apply' },
  { path: '/coaching/ai', what: 'This training assistant chat, full screen', how: 'Coach tab' },
  { path: '/coaching/ai/setup', what: 'Training assistant setup and consent', how: 'Coach tab → Set up training assistant' },
  { path: '/coaching/ai/settings', what: 'Training assistant settings: what the AI can see (Profile, Training, Measurements, Nutrition), notes, assistant style, pause', how: 'Coach tab → ⋮ → Settings' },
  { path: '/coaching/ai/proposals', what: 'AI suggestions: plan changes to review and apply', how: 'Coach tab → ⋮ → AI suggestions' },
];

/** Flag defaults: off, as in the app (src/config/featureFlags.ts DEFAULT_FLAGS). */
const FLAG_DEFAULTS: Record<GuideFlag, boolean> = { coachMarketplace: false, socialFeed: false };

/** Env names the ai-coach function reads (the app's VITE_ names without the prefix; either form is accepted). */
export const GUIDE_FLAG_ENV: Record<GuideFlag, string> = { coachMarketplace: 'ENABLE_COACH_MARKETPLACE', socialFeed: 'ENABLE_SOCIAL_FEED' };

function parseFlagValue(v: string | undefined): boolean | undefined {
  const t = (v ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(t)) return true;
  if (['0', 'false', 'no', 'off'].includes(t)) return false;
  return undefined;
}

/** The server's view of the feature flags (ENABLE_… or VITE_ENABLE_… env; unset or unrecognised = off). */
export function guideFeaturesFromEnv(env: (name: string) => string | undefined): Required<GuideFeatures> {
  const out = { ...FLAG_DEFAULTS };
  for (const k of Object.keys(GUIDE_FLAG_ENV) as GuideFlag[]) {
    const v = parseFlagValue(env(GUIDE_FLAG_ENV[k])) ?? parseFlagValue(env(`VITE_${GUIDE_FLAG_ENV[k]}`));
    if (v !== undefined) out[k] = v;
  }
  return out;
}

const flagOn = (flag: GuideFlag, features?: GuideFeatures) => features?.[flag] ?? FLAG_DEFAULTS[flag];

/** The guide entries for the areas that are switched on. */
export function guideEntries(features?: GuideFeatures): GuideEntry[] {
  return APP_GUIDE.filter((g) => !g.flag || flagOn(g.flag, features)).map((g) => {
    if (g.path === '/coaching' && flagOn('coachMarketplace', features)) return { ...g, what: `${g.what}, find a coach`, how: 'Coach tab → Coaching' };
    if (g.path === '/feed/new' && flagOn('socialFeed', features)) return { ...g, how: 'Feed tab → New post, or Workout summary → Share' };
    return g;
  });
}

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
/** Recipe links ([[open:/nutrition/recipes/<id>|Open recipe]]) are counted separately: up to 3 recipes per message. */
export const MAX_RECIPE_LINKS = 3;

/** Compact guide text for the system prompt (only the areas that are switched on). */
export function appGuideText(features?: GuideFeatures): string {
  return guideEntries(features).map((g) => `- ${g.path} — ${g.what} (${g.how})`).join('\n');
}

export interface KnownIds {
  exercise?: Set<string>;
  recipe?: Set<string>;
  completedSession?: Set<string>;
}

const OPEN_RE = /\[\[\s*open\s*:\s*([^|\]\s]+)\s*(?:\|\s*([^\]]*?))?\s*\]\]/gi;
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * The guide entry a path matches (params need a known id when `known` is given; the app passes none). Paths of areas
 * that are switched off (see `features`; default off) don't match.
 */
export function matchGuidePath(path: string, known?: KnownIds, features?: GuideFeatures): GuideEntry | null {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[?#\\\s]/.test(path)) return null;
  const parts = path.split('/');
  for (const g of APP_GUIDE) {
    if (g.flag && !flagOn(g.flag, features)) continue;
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
const isRecipePath = (p: string) => p.startsWith('/nutrition/recipes/');

/**
 * Removes [[open:…]] markers (\u0001 placeholders) and the lines they leave dangling: a line that held only a link,
 * a lead-in line ending with ":" right before it ("Open the meal plan:"), inline lead-ins ending with ":", and
 * trailing lines that end with ":" with nothing after them.
 */
function cleanAfterMarkers(withPlaceholders: string): string {
  const out: string[] = [];
  for (const line of withPlaceholders.split('\n')) {
    if (!line.includes('\u0001')) {
      out.push(line);
      continue;
    }
    const rest = line.replace(/\u0001/g, '').replace(/[ \t]{2,}/g, ' ').trim();
    // an inline lead-in ("… Open the meal plan: [[open:…]]") loses its last clause; earlier sentences stay
    const kept = /:\s*$/.test(rest) ? rest.replace(/(^|[.!?]\s+)[^.!?]*:\s*$/, '$1').trim() : rest;
    if (kept && kept !== rest) {
      out.push(kept);
      continue;
    }
    if (!rest || /:\s*$/.test(rest)) {
      // drop it, and a lead-in line just above that ends with ":"
      while (out.length && !out[out.length - 1].trim()) out.pop();
      if (out.length && /:\s*$/.test(out[out.length - 1]) && !/^\s*([-*•]|\d+[.)])\s/.test(out[out.length - 1])) out.pop();
      out.push('');
      continue;
    }
    out.push(line.replace(/\s*\u0001\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trimEnd());
  }
  while (out.length && (!out[out.length - 1].trim() || /:\s*$/.test(out[out.length - 1]))) out.pop();
  return out.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Server side: keep at most MAX_OPEN_LINKS valid screen links and MAX_RECIPE_LINKS valid recipe links (canonical form),
 * remove invalid or extra ones, clean the lines they leave behind, and put the kept links at the end of the message.
 */
export function validateOpenLinks(text: string, known: KnownIds, features?: GuideFeatures): { text: string; kept: { path: string; label: string }[]; removed: number } {
  const kept: { path: string; label: string }[] = [];
  let removed = 0;
  let any = false;
  const marked = String(text ?? '').replace(OPEN_RE, (_m, rawPath: string, rawLabel?: string) => {
    any = true;
    const path = rawPath.trim();
    const recipe = isRecipePath(path);
    const room = kept.filter((k) => isRecipePath(k.path) === recipe).length < (recipe ? MAX_RECIPE_LINKS : MAX_OPEN_LINKS);
    if (room && matchGuidePath(path, known, features) && !kept.some((k) => k.path === path)) kept.push({ path, label: cleanLabel(rawLabel) });
    else removed++;
    return '\u0001';
  });
  if (!any) return { text: marked, kept, removed };
  const body = cleanAfterMarkers(marked);
  return { text: [body, ...kept.map((k) => `[[open:${k.path}|${k.label}]]`)].filter(Boolean).join('\n'), kept, removed };
}

/**
 * App side: split a stored reply into the text to render and the link buttons (re-checked against the guide's
 * patterns; screen and recipe limits as above). Markers and the lines they leave dangling are removed from the text.
 */
export function extractOpenLinks(text: string, features?: GuideFeatures): { text: string; links: { path: string; label: string }[] } {
  const links: { path: string; label: string }[] = [];
  let any = false;
  const marked = String(text ?? '').replace(OPEN_RE, (_m, rawPath: string, rawLabel?: string) => {
    any = true;
    const path = rawPath.trim();
    const recipe = isRecipePath(path);
    const room = links.filter((k) => isRecipePath(k.path) === recipe).length < (recipe ? MAX_RECIPE_LINKS : MAX_OPEN_LINKS);
    if (room && matchGuidePath(path, undefined, features) && !links.some((l) => l.path === path)) links.push({ path, label: cleanLabel(rawLabel) });
    return '\u0001';
  });
  return { text: any ? cleanAfterMarkers(marked) : marked.trim(), links };
}
