import type { ReactNode } from 'react';
import type { MovementPattern } from '@/domain/types';

/**
 * Intentional visual placeholder: a simple line glyph per movement pattern.
 * Used instead of photos/video (we only ship media we can verify licensing for).
 * Draws with currentColor so it follows the surrounding text colour/theme.
 */
const Ground = () => <path d="M6 42h36" strokeOpacity={0.35} />;

const GLYPHS: Record<MovementPattern, ReactNode> = {
  squat: (
    <>
      <circle cx="24" cy="9.5" r="3.5" />
      <path d="M11 16h26M11 13v6M37 13v6" />
      <path d="M24 16l-2 11 9 1-2 12" />
      <Ground />
    </>
  ),
  lunge: (
    <>
      <circle cx="24" cy="8" r="3.5" />
      <path d="M24 12v13" />
      <path d="M24 25l8 5v10" />
      <path d="M24 25l-6 12-7 1" />
      <path d="M24 15l-3 8M24 15l3 8" strokeOpacity={0.6} />
      <Ground />
    </>
  ),
  hinge: (
    <>
      <circle cx="35" cy="15" r="3.5" />
      <path d="M31 18L15 23" />
      <path d="M15 23l3 9-1 8" />
      <path d="M29 19l1 13" />
      <circle cx="30" cy="36" r="4" />
      <Ground />
    </>
  ),
  horizontal_push: (
    <>
      <path d="M8 32h32M12 32v8M36 32v8" />
      <circle cx="10.5" cy="27" r="3" />
      <path d="M14 28.5h16l6 1 1 10" />
      <path d="M17 28.5V17" />
      <circle cx="17" cy="14" r="3" />
    </>
  ),
  vertical_push: (
    <>
      <path d="M9 6h30M9 3v6M39 3v6" />
      <circle cx="24" cy="14" r="3.5" />
      <path d="M24 18v13" />
      <path d="M21 19l-4-13M27 19l4-13" />
      <path d="M24 31l-4 11M24 31l4 11" />
    </>
  ),
  horizontal_pull: (
    <>
      <path d="M9 35h14" />
      <circle cx="18" cy="12.5" r="3.5" />
      <path d="M16 33l2-17" />
      <path d="M16 33l18-2" />
      <path d="M36 26v10" />
      <path d="M18 19l-6 4 9 1" />
      <path d="M21 24h19" strokeOpacity={0.5} strokeDasharray="2 3" />
    </>
  ),
  vertical_pull: (
    <>
      <path d="M8 6h32" />
      <path d="M17 6l4 13M31 6l-4 13" />
      <circle cx="24" cy="14.5" r="3.5" />
      <path d="M24 18.5V30" />
      <path d="M24 30l-2 10M24 30l3 9" />
    </>
  ),
  trunk: (
    <>
      <circle cx="38" cy="21" r="3.5" />
      <path d="M34 25L10 33" />
      <path d="M32 26v8h6" />
      <Ground />
    </>
  ),
  carry: (
    <>
      <circle cx="24" cy="8.5" r="3.5" />
      <path d="M24 12.5V27" />
      <path d="M24 27l-4 13M24 27l4 13" />
      <path d="M24 15l-8 11M24 15l8 11" />
      <path d="M16 26v7M14 27h4M14 33h4" />
      <path d="M32 26v7M30 27h4M30 33h4" />
      <Ground />
    </>
  ),
  isolation_upper: (
    <>
      <path d="M14 12l4 20 13-10" />
      <circle cx="13" cy="10" r="2.5" />
      <path d="M30 18l6 7" />
      <circle cx="29" cy="16.5" r="2.5" />
      <circle cx="37" cy="26.5" r="2.5" />
      <path d="M20 16c3 2 5 5 5 9" strokeOpacity={0.45} />
    </>
  ),
  isolation_lower: (
    <>
      <path d="M10 14v16h16" />
      <circle cx="14" cy="9.5" r="3.5" />
      <path d="M14 13.5l2 14.5h12" />
      <path d="M28 28l12-4" />
      <circle cx="39.5" cy="27.5" r="2.2" />
      <path d="M18 30v10" strokeOpacity={0.45} />
    </>
  ),
  conditioning: (
    <>
      <path d="M4 26h9l4-10 6 18 5-14 3 6h13" />
      <path d="M10 38h28" strokeOpacity={0.35} />
    </>
  ),
  mobility: (
    <>
      <path d="M11 33A15 15 0 1 1 24 39" strokeOpacity={0.55} />
      <path d="M8 30l3 3 4-2" strokeOpacity={0.55} />
      <circle cx="24" cy="14" r="2.8" />
      <path d="M24 17v10" />
      <path d="M24 20l-6-6M24 20l6-6" />
      <path d="M24 27l-3 7M24 27l3 7" />
    </>
  ),
};

export function ExerciseGlyph({ pattern, className }: { pattern: MovementPattern; className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className ?? 'size-8'}
    >
      {GLYPHS[pattern] ?? GLYPHS.conditioning}
    </svg>
  );
}

/** Glyph in a rounded tile, as used in exercise lists. */
export function ExerciseGlyphTile({ pattern, size = 'md' }: { pattern: MovementPattern; size?: 'md' | 'lg' }) {
  return (
    <span
      className={
        size === 'lg'
          ? 'inline-flex size-20 items-center justify-center rounded-2xl bg-surface-2 text-accent'
          : 'inline-flex size-11 items-center justify-center rounded-xl bg-surface-2 text-accent'
      }
    >
      <ExerciseGlyph pattern={pattern} className={size === 'lg' ? 'size-14' : 'size-8'} />
    </span>
  );
}
