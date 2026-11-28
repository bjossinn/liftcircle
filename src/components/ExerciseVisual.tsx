import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Pause, Play } from 'lucide-react';
import type { Exercise } from '@/domain/types';
import { EXERCISE_MEDIA_CREDIT, exerciseMedia, type ExerciseMedia } from '@/data/exerciseMedia';
import { ExerciseGlyphTile } from '@/components/ExerciseGlyph';
import { useT } from '@/i18n';

/**
 * Exercise illustrations: start/end line drawings for mapped library exercises (src/data/exerciseMedia.ts), the
 * movement-pattern glyph for everything else. Images are lazy-loaded, have fixed intrinsic sizes (no layout shift) and
 * fall back to the glyph if a file fails to load, so a broken image is never shown.
 */

const FRAME_MS = 1400;

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Live `prefers-reduced-motion` value. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    } catch {
      return;
    }
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return reduced;
}

function Frame({ src, alt, size, className, hidden, onError }: { src: string; alt: string; size: number; className?: string; hidden?: boolean; onError: () => void }) {
  return (
    <img
      src={src}
      alt={hidden ? '' : alt}
      aria-hidden={hidden || undefined}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={onError}
      className={clsx('exercise-art block size-full object-contain', className)}
    />
  );
}

/**
 * The full illustration: frames alternate (with a pause button); with reduced motion both frames are shown side by
 * side, labelled. Returns null when the exercise has no illustration or a frame failed to load, unless `placeholder`.
 */
export function ExerciseIllustration({ ex, compact, className }: { ex: Exercise; compact?: boolean; className?: string }) {
  const media = ex.custom ? null : exerciseMedia(ex.id);
  const [failed, setFailed] = useState(false);
  if (!media || failed) return null;
  return <Illustration key={ex.id} ex={ex} media={media} compact={compact} className={className} onFail={() => setFailed(true)} />;
}

function Illustration({ ex, media, compact, className, onFail }: { ex: Exercise; media: ExerciseMedia; compact?: boolean; className?: string; onFail: () => void }) {
  const { t } = useT();
  const reduced = useReducedMotion();
  const [paused, setPaused] = useState(false);
  const [frame, setFrame] = useState<0 | 1>(0);
  const animate = !reduced && !paused;

  useEffect(() => {
    if (!animate) return;
    const timer = window.setInterval(() => setFrame((f) => (f === 0 ? 1 : 0)), FRAME_MS);
    return () => window.clearInterval(timer);
  }, [animate]);

  const alts = [t('exercise.visual.altStart', { exercise: ex.name }), t('exercise.visual.altEnd', { exercise: ex.name })] as const;
  const labels = [t('exercise.visual.start'), t('exercise.visual.end')] as const;
  const size = 480;

  return (
    <figure className={clsx('m-0', className)} data-testid="exercise-illustration">
      {reduced ? (
        <div className="grid grid-cols-2 gap-2">
          {media.frames.map((src, i) => (
            <div key={src}>
              <div className="aspect-square rounded-xl bg-surface-2 p-2">
                <Frame src={src} alt={alts[i]} size={size} onError={onFail} />
              </div>
              <p className="mt-1 text-center text-xs text-muted" aria-hidden>
                {labels[i]}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <div className={clsx('relative mx-auto aspect-square rounded-xl bg-surface-2 p-2', compact ? 'max-w-56' : 'max-w-80')}>
          {media.frames.map((src, i) => (
            <Frame
              key={src}
              src={src}
              alt={alts[i]}
              size={size}
              onError={onFail}
              hidden={frame !== i}
              // Both frames stay in the DOM (and loaded) so switching never flickers; the hidden one is out of the a11y tree.
              className={clsx('absolute inset-0 p-2 transition-opacity duration-300', frame === i ? 'opacity-100' : 'opacity-0')}
            />
          ))}
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            aria-pressed={paused}
            aria-label={paused ? t('exercise.visual.play') : t('exercise.visual.pause')}
            className="absolute bottom-1.5 right-1.5 inline-flex size-9 items-center justify-center rounded-full bg-surface/90 text-muted border border-line hover:text-ink"
          >
            {paused ? <Play className="size-4" aria-hidden /> : <Pause className="size-4" aria-hidden />}
          </button>
        </div>
      )}
      <figcaption className="mt-2 text-center text-[11px] leading-snug text-faint">
        {media.variant && <span className="block text-xs text-muted">{t(media.variant === 'withBarbell' ? 'exercise.visual.withBarbell' : 'exercise.visual.withoutLoad')}</span>}
        {t('exercise.visual.credit', { author: EXERCISE_MEDIA_CREDIT.author })},{' '}
        <a href={EXERCISE_MEDIA_CREDIT.licenseUrl} target="_blank" rel="noopener noreferrer" className="underline">
          {EXERCISE_MEDIA_CREDIT.license}
        </a>
      </figcaption>
    </figure>
  );
}

/**
 * Small square thumbnail for lists and the workout logger (44 px, fixed size). Mapped exercises show the end-position
 * frame; others (custom, unmapped, failed load) show the movement-pattern glyph, so there is never a broken image.
 */
export function ExerciseThumb({ ex, className }: { ex: Exercise; className?: string }) {
  const media = ex.custom ? null : exerciseMedia(ex.id);
  const [failed, setFailed] = useState(false);
  if (!media || failed) return <ExerciseGlyphTile pattern={ex.pattern} />;
  return (
    <span className={clsx('inline-flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-surface-2 p-0.5', className)}>
      <img
        src={media.thumb}
        alt=""
        width={96}
        height={96}
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setFailed(true)}
        className="exercise-art block size-full object-contain"
      />
    </span>
  );
}

/** Whether a library exercise has an illustration (for showing the logger's expand control). */
export function hasIllustration(ex: Exercise | undefined): boolean {
  return !!ex && !ex.custom && !!exerciseMedia(ex.id);
}
