import { useState } from 'react';
import clsx from 'clsx';
import type { Exercise } from '@/domain/types';
import { EXERCISE_MEDIA_FULL_SIZE, exerciseCueKeys, exerciseMedia } from '@/data/exerciseMedia';
import { ExerciseGlyphTile } from '@/components/ExerciseGlyph';
import { useT } from '@/i18n';
import { exerciseDisplayName } from '@/data/catalogText';

/**
 * Exercise illustrations (src/data/exerciseMedia.ts): one two-panel image per library exercise (start and end position
 * side by side) with short, translated technique cues underneath. Custom exercises show the movement-pattern glyph.
 * Images are lazy-loaded with fixed intrinsic sizes (no layout shift). A failed load hides the image (the cues stay)
 * or falls back to the glyph, so a broken image is never shown.
 *
 * A load failure is remembered per image source, not per component: when the same logger row switches to another
 * exercise (a swap), the new exercise's image is tried even if the previous one failed offline.
 */
export function ExerciseIllustration({ ex, compact, className }: { ex: Exercise; compact?: boolean; className?: string }) {
  const { t } = useT();
  const media = ex.custom ? null : exerciseMedia(ex.id);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (!media) return null;
  const cues = exerciseCueKeys(ex.id);
  const showImage = failedSrc !== media.full;
  if (!showImage && !cues.length) return null;
  return (
    <div className={className} data-testid="exercise-visual">
      {showImage && (
        <figure className="m-0" data-testid="exercise-illustration">
          <div className={clsx('mx-auto aspect-square overflow-hidden rounded-xl bg-surface-2', compact ? 'max-w-72' : 'max-w-sm')}>
            <img
              src={media.full}
              alt={t('exercise.visual.alt', { exercise: exerciseDisplayName(ex) })}
              width={EXERCISE_MEDIA_FULL_SIZE}
              height={EXERCISE_MEDIA_FULL_SIZE}
              loading="lazy"
              decoding="async"
              draggable={false}
              onError={() => setFailedSrc(media.full)}
              className="block size-full object-contain"
            />
          </div>
        </figure>
      )}
      {cues.length > 0 && (
        <div className={clsx(showImage && 'mt-3', compact ? 'mx-auto max-w-72' : 'mx-auto max-w-sm')}>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{t('exercise.visual.cuesTitle')}</h3>
          <ol className="mt-1.5 flex flex-col gap-1 text-sm leading-snug" data-testid="exercise-cues">
            {cues.map((key, i) => (
              <li key={key} className="flex gap-2">
                <span className="tabular w-4 shrink-0 text-right font-semibold text-accent" aria-hidden>
                  {i + 1}
                </span>
                <span>{t(key)}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

/**
 * Small square mark for lists, the picker and the compact logger row (44 px, fixed size): always the Direction B
 * movement-pattern tile. The 256 px photo thumbnails are not loaded here (unreadable at 44 px and not theme-aware);
 * the full start/end illustration is shown on the exercise page and in the expanded logger row (ExerciseIllustration).
 */
export function ExerciseThumb({ ex, className }: { ex: Exercise; className?: string }) {
  return <ExerciseGlyphTile pattern={ex.pattern} className={className} />;
}

/** Whether an exercise has an illustration (library exercises; for showing the logger's expand control). */
export function hasIllustration(ex: Exercise | undefined): boolean {
  return !!ex && !ex.custom && !!exerciseMedia(ex.id);
}
