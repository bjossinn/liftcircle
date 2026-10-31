/**
 * Original in-house empty-state drawings (no third-party characters or brand art). Simple shapes coloured with
 * theme tokens via Tailwind fill/stroke classes, so they follow the dark and light themes. Decorative: aria-hidden,
 * the EmptyState title says what's going on. Imported only by the lazy-loaded screens that use them, so they stay
 * out of the startup bundle.
 */
const svg = { viewBox: '0 0 160 120', 'aria-hidden': true, focusable: false, className: 'w-full h-auto' } as const;

/** No workouts yet: a dumbbell resting on a mat, with a little sparkle. */
export function NoWorkoutsArt() {
  return (
    <svg {...svg}>
      <circle cx="80" cy="58" r="46" className="fill-accent-soft" />
      <rect x="28" y="84" width="104" height="10" rx="5" className="fill-surface-3" />
      <rect x="50" y="62" width="60" height="8" rx="4" className="fill-muted" />
      <rect x="38" y="48" width="14" height="36" rx="5" className="fill-accent" />
      <rect x="108" y="48" width="14" height="36" rx="5" className="fill-accent" />
      <rect x="30" y="56" width="10" height="20" rx="4" className="fill-ember" />
      <rect x="120" y="56" width="10" height="20" rx="4" className="fill-ember" />
      <path d="M124 22l3 8 8 3-8 3-3 8-3-8-8-3 8-3z" className="fill-celebrate" />
      <circle cx="40" cy="26" r="3" className="fill-accent-2" />
    </svg>
  );
}

/** No meal plan: a steaming bowl with a leaf. */
export function NoMealPlanArt() {
  return (
    <svg {...svg}>
      <circle cx="80" cy="60" r="46" className="fill-accent-2-soft" />
      <path d="M62 30c-4 6 4 9 0 15M80 26c-4 7 4 10 0 17M98 30c-4 6 4 9 0 15" strokeWidth="4" strokeLinecap="round" fill="none" className="stroke-faint" />
      <path d="M36 62h88c0 22-18 36-44 36S36 84 36 62z" className="fill-accent-2" />
      <rect x="32" y="56" width="96" height="10" rx="5" className="fill-surface-3" />
      <circle cx="64" cy="57" r="9" className="fill-celebrate" />
      <circle cx="84" cy="54" r="10" className="fill-accent" />
      <path d="M104 46c10-4 18 2 18 2s-6 9-16 7c-4-1-5-6-2-9z" className="fill-ember" />
    </svg>
  );
}

/** No friends yet: two friendly figures waving, and a heart. */
export function NoFriendsArt() {
  return (
    <svg {...svg}>
      <circle cx="80" cy="60" r="46" className="fill-streak-soft" />
      <circle cx="62" cy="44" r="12" className="fill-accent" />
      <path d="M40 100c0-18 10-30 22-30s22 12 22 30z" className="fill-accent" />
      <circle cx="100" cy="48" r="11" className="fill-accent-2" />
      <path d="M80 100c0-16 9-27 20-27s20 11 20 27z" className="fill-accent-2" />
      <path d="M118 66l10-14" strokeWidth="6" strokeLinecap="round" className="stroke-accent-2" />
      <path d="M81 24c-3-4-10-2-9 3 0 4 9 9 9 9s9-5 9-9c1-5-6-7-9-3z" className="fill-streak" />
    </svg>
  );
}

/** Empty coach chat: two speech bubbles, one thinking, one with a spark. */
export function EmptyChatArt() {
  return (
    <svg {...svg}>
      <circle cx="80" cy="60" r="46" className="fill-accent-soft" />
      <path d="M30 34h62a10 10 0 0110 10v22a10 10 0 01-10 10H52l-12 10v-10h-10a10 10 0 01-10-10V44a10 10 0 0110-10z" className="fill-surface-3" />
      <circle cx="46" cy="55" r="4" className="fill-muted" />
      <circle cx="61" cy="55" r="4" className="fill-muted" />
      <circle cx="76" cy="55" r="4" className="fill-muted" />
      <path d="M78 62h52a10 10 0 0110 10v16a10 10 0 01-10 10h-4v10l-12-10H78a10 10 0 01-10-10V72a10 10 0 0110-10z" className="fill-accent" />
      <path d="M104 70l2.5 6.5 6.5 2.5-6.5 2.5-2.5 6.5-2.5-6.5-6.5-2.5 6.5-2.5z" className="fill-accent-ink" />
    </svg>
  );
}
