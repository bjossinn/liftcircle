import type { ReactNode } from 'react';
import clsx from 'clsx';
import type { MovementPattern } from '@/domain/types';
import { ICON_STROKE } from '@/components/Icon';

/**
 * Direction B movement-pattern pictograms: one 24×24 line figure per movement pattern, drawn for a 24 px mark inside a
 * 44 px tile (stroke 1.75, round caps and joins, `currentColor`; only heads and plates are filled where it helps).
 * Used in every exercise list, the picker and the compact logger row (ExerciseThumb), for custom exercises, and large
 * on the exercise detail header. The full start/end illustrations (full.webp) stay on the detail page and the
 * expanded logger row.
 */
const Ground = () => <path d="M3 21.2h18" strokeOpacity={0.35} />;
const Head = ({ cx, cy }: { cx: number; cy: number }) => <circle cx={cx} cy={cy} r={1.7} fill="currentColor" stroke="none" />;

const GLYPHS: Record<MovementPattern, ReactNode> = {
  // Back squat, front view: bar across the shoulders, knees out.
  squat: (
    <>
      <Head cx={12} cy={4.6} />
      <path d="M3.6 8.1h16.8M3.6 6.6v3M20.4 6.6v3" />
      <path d="M12 8.1v4" />
      <path d="M12 12.1 8 15.3l.6 5.2M12 12.1l4 3.2-.6 5.2" />
      <Ground />
    </>
  ),
  // Split-stance lunge, side view.
  lunge: (
    <>
      <Head cx={11} cy={4.2} />
      <path d="M11 6.2v6.3" />
      <path d="M11 7.8l1.4 4" />
      <path d="M11 12.5l5 .8.4 7.2" />
      <path d="M11 12.5l-2.6 7.2-3.9.4" />
      <Ground />
    </>
  ),
  // Hip hinge / Romanian deadlift with a plate at the shins.
  hinge: (
    <>
      <Head cx={17.4} cy={5} />
      <path d="M16.1 6.5 8 12.4" />
      <path d="M8 12.4l.5 8.2" />
      <path d="M14.8 7.3 13.3 15" />
      <circle cx={13} cy={17.4} r={2.1} />
      <Ground />
    </>
  ),
  // Bench press, side view: lifter on a bench, bar pressed up.
  horizontal_push: (
    <>
      <path d="M2.8 16.2h13.4M5 16.2v4.3M14 16.2v4.3" />
      <Head cx={5} cy={13.3} />
      <path d="M6.7 14h8" />
      <path d="M14.7 14l3.3-2.6 1.4 9.1" />
      <path d="M9.2 14V7.6M12.6 14V7.6" />
      <path d="M6.4 7.6h9.2M6.4 6.2v2.8M15.6 6.2v2.8" />
    </>
  ),
  // Overhead press, front view: bar locked out overhead.
  vertical_push: (
    <>
      <path d="M4 3.8h16M4 2.4v2.8M20 2.4v2.8" />
      <Head cx={12} cy={8.4} />
      <path d="M9.5 11h5M9.5 11 8 4.1M14.5 11 16 4.1" />
      <path d="M12 11v4.6" />
      <path d="M12 15.6l-1.8 4.9M12 15.6l1.8 4.9" />
      <Ground />
    </>
  ),
  // Seated cable row: handle pulled to the torso, cable to the stack.
  horizontal_pull: (
    <>
      <path d="M2.8 20.5h7" />
      <Head cx={7.8} cy={7.6} />
      <path d="M7.6 9.6 6.8 18" />
      <path d="M6.8 18h9.2M17 15.2v4.6" />
      <path d="M7.5 11.2 5.3 13.6h4" />
      <path d="M9.3 13.6h10.2" strokeOpacity={0.5} strokeDasharray="1.5 2" />
      <path d="M20.6 9v11.5" />
    </>
  ),
  // Pull-up: hanging from a bar.
  vertical_pull: (
    <>
      <path d="M3 3.3h18" />
      <path d="M8.1 3.3l2.1 6.8M15.9 3.3l-2.1 6.8" />
      <Head cx={12} cy={7.6} />
      <path d="M12 9.6v5.3" />
      <path d="M12 14.9l-1.6 5.7M12 14.9l1.7 5.7" />
    </>
  ),
  // Forearm plank, side view.
  trunk: (
    <>
      <Head cx={4.6} cy={12.9} />
      <path d="M6.5 14.6l14 4.9" />
      <path d="M6.5 14.6V20h3.8" />
      <Ground />
    </>
  ),
  // Farmer's carry: a dumbbell in each hand.
  carry: (
    <>
      <Head cx={12} cy={4} />
      <path d="M12 5.9V13" />
      <path d="M9.5 7.5h5M9.5 7.5 7 12.4M14.5 7.5l2.5 4.9" />
      <path d="M7 12.4v4.4M5.8 12.4h2.4M5.8 16.8h2.4M17 12.4v4.4M15.8 12.4h2.4M15.8 16.8h2.4" />
      <path d="M12 13l-2 7.5M12 13l2 7.5" />
      <Ground />
    </>
  ),
  // Arm isolation (curl), side view.
  isolation_upper: (
    <>
      <Head cx={9.5} cy={4} />
      <path d="M9.5 6v7.6" />
      <path d="M9.5 7.4l.9 4.6 4.3-3.3" />
      <path d="M14 8.6h3M14 7.3v2.6M17 7.3v2.6" />
      <path d="M9.5 13.6l-1.5 6.9M9.5 13.6l1.5 6.9" />
      <Ground />
    </>
  ),
  // Leg isolation (leg extension), seated on a machine.
  isolation_lower: (
    <>
      <Head cx={6.8} cy={4.8} />
      <path d="M6.6 6.8 6 13" />
      <path d="M6 13h6l5.6-2.2" />
      <circle cx={18.8} cy={10.4} r={1.2} />
      <path d="M6.5 8.4l2 3.6" />
      <path d="M3.5 14.6h9M8 14.6v5.9M5 20.5h6" />
    </>
  ),
  // Conditioning: heart-rate pulse.
  conditioning: (
    <>
      <path d="M2.5 13.5h4l2.2-5.5 3.3 10 2.6-7.5 1.6 3h5.3" />
      <path d="M4 20h16" strokeOpacity={0.35} />
    </>
  ),
  // Mobility: seated forward fold, reaching for the toes.
  mobility: (
    <>
      <Head cx={13.4} cy={12.4} />
      <path d="M5.4 19.4 11.6 14.4" />
      <path d="M11.4 15l7.5 2.6" />
      <path d="M5.4 19.4h14M19.4 19.4v-2.6" />
      <Ground />
    </>
  ),
};

export function ExerciseGlyph({ pattern, className }: { pattern: MovementPattern; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-pattern={pattern}
      className={className ?? 'size-6'}
    >
      {GLYPHS[pattern] ?? GLYPHS.conditioning}
    </svg>
  );
}

/** Glyph in a Direction B tile (`bg-surface-2 text-accent rounded-xl`): md = 44 px tile / 24 px mark; lg = detail header. */
export function ExerciseGlyphTile({ pattern, size = 'md', className }: { pattern: MovementPattern; size?: 'md' | 'lg'; className?: string }) {
  return (
    <span
      data-testid="exercise-glyph-tile"
      className={clsx(
        'inline-flex shrink-0 items-center justify-center bg-surface-2 text-accent',
        size === 'lg' ? 'size-20 rounded-2xl' : 'size-11 rounded-xl',
        className,
      )}
    >
      <ExerciseGlyph pattern={pattern} className={size === 'lg' ? 'size-11' : 'size-6'} />
    </span>
  );
}
