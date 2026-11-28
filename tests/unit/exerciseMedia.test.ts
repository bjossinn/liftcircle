import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXERCISES } from '@/data/exercises';
import { EXERCISE_MEDIA_BASE, exerciseCueKeys, exerciseMedia, illustratedExerciseIds, MAX_EXERCISE_CUES } from '@/data/exerciseMedia';
import { EN, IS } from '@/i18n';

const PUBLIC = path.resolve(__dirname, '../../public');
const MEDIA_DIR = path.join(PUBLIC, EXERCISE_MEDIA_BASE);
const fileFor = (url: string) => path.join(PUBLIC, url);

/** Width and height from a WebP header (VP8, VP8L or VP8X). */
function webpSize(file: string): { width: number; height: number } {
  const b = fs.readFileSync(file);
  expect(b.subarray(0, 4).toString('latin1'), file).toBe('RIFF');
  expect(b.subarray(8, 12).toString('latin1'), file).toBe('WEBP');
  const chunk = b.subarray(12, 16).toString('latin1');
  if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  throw new Error(`${file}: unknown WebP chunk ${chunk}`);
}

describe('exercise illustrations (v2)', () => {
  it('every library exercise has full.webp (800×800) and thumb.webp (256×256)', () => {
    expect(EXERCISES).toHaveLength(105);
    expect(illustratedExerciseIds().sort()).toEqual(EXERCISES.map((e) => e.id).sort());
    const missing: string[] = [];
    for (const ex of EXERCISES) {
      const m = exerciseMedia(ex.id)!;
      expect(m.full).toBe(`${EXERCISE_MEDIA_BASE}${ex.id}/full.webp`);
      expect(m.thumb).toBe(`${EXERCISE_MEDIA_BASE}${ex.id}/thumb.webp`);
      for (const url of [m.full, m.thumb]) if (!fs.existsSync(fileFor(url))) missing.push(url);
    }
    expect(missing).toEqual([]);
    for (const ex of EXERCISES) {
      const m = exerciseMedia(ex.id)!;
      expect(webpSize(fileFor(m.full)), m.full).toEqual({ width: 800, height: 800 });
      expect(webpSize(fileFor(m.thumb)), m.thumb).toEqual({ width: 256, height: 256 });
      // Keep the logger fast: sensible file sizes.
      expect(fs.statSync(fileFor(m.full)).size, m.full).toBeLessThanOrEqual(60 * 1024);
      expect(fs.statSync(fileFor(m.thumb)).size, m.thumb).toBeLessThanOrEqual(12 * 1024);
    }
  });

  it('ships no stray folders or files (every folder is a library exercise with exactly full + thumb)', () => {
    const ids = new Set(EXERCISES.map((e) => e.id));
    const extra = fs.readdirSync(MEDIA_DIR).filter((d) => !ids.has(d));
    expect(extra).toEqual([]);
    for (const d of fs.readdirSync(MEDIA_DIR)) expect(fs.readdirSync(path.join(MEDIA_DIR, d)).sort(), d).toEqual(['full.webp', 'thumb.webp']);
    expect(fs.readdirSync(path.join(PUBLIC, 'exercise-media'))).toEqual(['v2']);
  });

  it('every library exercise has 3–4 technique cues, in English and Icelandic', () => {
    for (const ex of EXERCISES) {
      const keys = exerciseCueKeys(ex.id);
      expect(keys.length, ex.id).toBeGreaterThanOrEqual(3);
      expect(keys.length, ex.id).toBeLessThanOrEqual(MAX_EXERCISE_CUES);
      for (const k of keys) {
        expect(EN[k].trim().length, k).toBeGreaterThan(0);
        expect(IS[k].trim().length, k).toBeGreaterThan(0);
      }
    }
    // No orphan or out-of-range cue keys.
    const ids = new Set(EXERCISES.map((e) => e.id));
    for (const k of Object.keys(EN).filter((k) => k.startsWith('exercise.cues.'))) {
      const m = /^exercise\.cues\.(.+)\.([1-9])$/.exec(k);
      expect(m, k).not.toBeNull();
      expect(ids.has(m![1]), k).toBe(true);
      expect(Number(m![2]), k).toBeLessThanOrEqual(MAX_EXERCISE_CUES);
    }
  });

  it('custom and unknown exercises have no illustration or cues', () => {
    for (const id of [undefined, 'no-such-exercise', 'constructor', 'toString', '__proto__']) {
      expect(exerciseMedia(id)).toBeNull();
      expect(exerciseCueKeys(id)).toEqual([]);
    }
  });
});
