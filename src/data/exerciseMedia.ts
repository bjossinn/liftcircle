/**
 * Exercise illustrations (roadmap item 13, PR 2). Every library exercise has one illustration made for Hard Earned
 * (docs/THIRD_PARTY_MEDIA.md): a two-panel image that shows the start and end positions side by side, plus a small
 * thumbnail. They are self-hosted under public/exercise-media/v2/<exercise id>/ (same origin, so the CSP's
 * `img-src 'self'` covers them). Custom exercises have no illustration and keep the movement-pattern glyph.
 *
 * Short technique cues for each exercise are i18n strings (`exercise.cues.<id>.<n>`), not part of the images.
 */
import { EXERCISES } from './exercises';
import { EN, type MessageKey } from '@/i18n';

/** Bump the folder (and the Workbox cache name in vite.config.ts) when files change: they're cached immutably. */
export const EXERCISE_MEDIA_BASE = '/exercise-media/v2/';
export const EXERCISE_MEDIA_FULL_SIZE = 800;
export const EXERCISE_MEDIA_THUMB_SIZE = 256;
/** At most this many cues per exercise (`exercise.cues.<id>.1` … `.4`). */
export const MAX_EXERCISE_CUES = 4;

export interface ExerciseMedia {
  /** 800×800 two-panel image: start position on the left, end position on the right. */
  full: string;
  /** 256×256 thumbnail. Kept on disk and in the manifest, but no longer shown: lists use the movement-pattern tile. */
  thumb: string;
}

const LIBRARY_IDS: ReadonlySet<string> = new Set(EXERCISES.map((e) => e.id));

/** Library exercise ids that have illustrations (all of them). */
export function illustratedExerciseIds(): string[] {
  return [...LIBRARY_IDS];
}

/** The illustration for a library exercise, or null (custom/unknown exercises). */
export function exerciseMedia(exerciseId: string | undefined): ExerciseMedia | null {
  if (!exerciseId || !LIBRARY_IDS.has(exerciseId)) return null;
  const base = `${EXERCISE_MEDIA_BASE}${encodeURIComponent(exerciseId)}/`;
  return { full: `${base}full.webp`, thumb: `${base}thumb.webp` };
}

/** i18n keys of an exercise's technique cues, in order (empty for custom/unknown exercises). */
export function exerciseCueKeys(exerciseId: string | undefined): MessageKey[] {
  if (!exerciseId || !LIBRARY_IDS.has(exerciseId)) return [];
  const keys: MessageKey[] = [];
  for (let n = 1; n <= MAX_EXERCISE_CUES; n++) {
    const key = `exercise.cues.${exerciseId}.${n}`;
    if (!Object.hasOwn(EN, key)) break;
    keys.push(key as MessageKey);
  }
  return keys;
}
