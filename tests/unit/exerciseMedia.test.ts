import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXERCISES } from '@/data/exercises';
import { EXERCISE_MEDIA_BASE, EXERCISE_MEDIA_MAPPING, exerciseMedia, mediaDir } from '@/data/exerciseMedia';
import type { Exercise } from '@/domain/types';

const PUBLIC = path.resolve(__dirname, '../../public');
const byId = new Map(EXERCISES.map((e) => [e.id, e]));
const fileFor = (url: string) => path.join(PUBLIC, url);

/**
 * "Obviously wrong movement" guard. Each rule: if the library exercise's name matches `ours`, the illustration's source
 * name must match `source`. Then movement words the library name does NOT contain must not appear in the source name
 * either (a curl is never illustrated by a squat).
 */
const MOVEMENT_RULES: { ours: RegExp; source: RegExp }[] = [
  { ours: /squat/i, source: /squat/ },
  { ours: /leg press/i, source: /leg-press/ },
  { ours: /lunge/i, source: /lunge/ },
  { ours: /step-up/i, source: /step-up/ },
  { ours: /deadlift/i, source: /dead-?lift/ },
  { ours: /bridge/i, source: /bridg/ },
  { ours: /back extension/i, source: /hyperextension|back-extension/ },
  { ours: /press/i, source: /press/ },
  { ours: /push-up/i, source: /push-?up/ },
  { ours: /\bfly\b/i, source: /fly|flys|crossover|rear-delt/ },
  { ours: /\bdip\b/i, source: /dip/ },
  { ours: /\brow\b/i, source: /row/ },
  { ours: /pull-up/i, source: /pull-ups?/ },
  { ours: /pulldown/i, source: /pull-?down|push-down/ },
  { ours: /lateral raise/i, source: /lateral-.*raise/ },
  { ours: /rear delt/i, source: /rear-delt/ },
  { ours: /leg curl/i, source: /leg-curl/ },
  { ours: /^(?!.*leg).*curl/i, source: /(biceps|hammer)-curl|curls?-with/ },
  { ours: /pushdown/i, source: /pushdown/ },
  { ours: /skull crusher/i, source: /skull|triceps-press/ },
  { ours: /leg extension/i, source: /leg-extension/ },
  { ours: /calf raise/i, source: /calf-raise/ },
  { ours: /plank/i, source: /plank/ },
  { ours: /crunch/i, source: /crunch|hip-raise/ },
];
/** Movement words a source name may only contain if the library name contains them too. */
const EXCLUSIVE_WORDS: { word: RegExp; ours: RegExp }[] = [
  { word: /curl/, ours: /curl/i },
  { word: /squat/, ours: /squat/i },
  { word: /lunge/, ours: /lunge/i },
  { word: /dead-?lift/, ours: /deadlift/i },
  { word: /row/, ours: /\brow\b/i },
  { word: /fly|flys/, ours: /\bfly\b/i },
  { word: /crunch/, ours: /crunch/i },
  { word: /dip/, ours: /\bdip\b/i },
  { word: /pull-?up/, ours: /pull-up/i },
  { word: /extension/, ours: /extension/i },
  { word: /shrug/, ours: /shrug/i },
  { word: /kickback/, ours: /kickback/i },
];
/** Equipment words in a source name the library exercise must use too, unless a variant explains the difference. */
const EQUIPMENT_WORDS: { word: RegExp; equipment: Exercise['equipment'][number][]; variant?: string }[] = [
  { word: /barbell/, equipment: ['barbell', 'ez_bar'], variant: 'withBarbell' }, // an EZ bar is a (bent) barbell
  { word: /dumbbell/, equipment: ['dumbbell'] },
  { word: /cable/, equipment: ['cable'] },
  { word: /band/, equipment: ['band'] },
  { word: /machine/, equipment: ['machine'] },
];

function mappingProblems(ex: Exercise, sourceName: string, variant?: string): string[] {
  const problems: string[] = [];
  for (const r of MOVEMENT_RULES) if (r.ours.test(ex.name) && !r.source.test(sourceName)) problems.push(`"${ex.name}" needs ${r.source} in "${sourceName}"`);
  for (const w of EXCLUSIVE_WORDS) if (w.word.test(sourceName) && !w.ours.test(ex.name)) problems.push(`"${sourceName}" is a ${w.word} movement but "${ex.name}" isn't`);
  for (const q of EQUIPMENT_WORDS)
    if (q.word.test(sourceName) && !q.equipment.some((e) => ex.equipment.includes(e)) && !(q.variant && variant === q.variant)) problems.push(`"${sourceName}" uses ${q.equipment[0]}; "${ex.name}" doesn't`);
  if (variant === 'withoutLoad' && ex.tracking !== 'bodyweight_plus') problems.push(`"${ex.name}" isn't a loaded bodyweight exercise, so "withoutLoad" doesn't apply`);
  return problems;
}

describe('exercise illustration mapping', () => {
  const entries = Object.entries(EXERCISE_MEDIA_MAPPING);

  it('maps only library exercises, and a meaningful share of them', () => {
    for (const [id] of entries) expect(byId.has(id), id).toBe(true);
    expect(entries.length).toBeGreaterThanOrEqual(45);
    console.info(`exercise illustrations: ${entries.length} / ${EXERCISES.length} library exercises mapped`);
  });

  it('every mapped path exists, frames stay within the size budget, and no file is unreferenced', () => {
    const used = new Set<string>();
    for (const [id] of entries) {
      const m = exerciseMedia(id)!;
      for (const url of [...m.frames, m.thumb]) {
        expect(url.startsWith(EXERCISE_MEDIA_BASE), url).toBe(true);
        expect(fs.existsSync(fileFor(url)), `${id}: ${url}`).toBe(true);
        used.add(path.relative(PUBLIC, fileFor(url)));
      }
      for (const url of m.frames) expect(fs.statSync(fileFor(url)).size, url).toBeLessThanOrEqual(40 * 1024);
      expect(fs.statSync(fileFor(m.thumb)).size, m.thumb).toBeLessThanOrEqual(8 * 1024);
    }
    const dir = path.join(PUBLIC, EXERCISE_MEDIA_BASE);
    const onDisk = fs.readdirSync(dir).flatMap((d) => fs.readdirSync(path.join(dir, d)).map((f) => path.relative(PUBLIC, path.join(dir, d, f))));
    expect(onDisk.filter((f) => !used.has(f))).toEqual([]);
  });

  it('files are real WebP images', () => {
    for (const [, entry] of entries) {
      const head = fs.readFileSync(path.join(PUBLIC, EXERCISE_MEDIA_BASE, mediaDir(entry), '0.webp')).subarray(0, 12).toString('latin1');
      expect(head.slice(0, 4)).toBe('RIFF');
      expect(head.slice(8, 12)).toBe('WEBP');
    }
  });

  it('no exercise is illustrated by an obviously different movement or implement', () => {
    const problems = entries.flatMap(([id, m]) => mappingProblems(byId.get(id)!, m.sourceName, m.variant));
    expect(problems).toEqual([]);
  });

  it('the movement guard catches wrong mappings', () => {
    const curl = byId.get('barbell-curl')!;
    expect(mappingProblems(curl, 'barbell-squat')).not.toEqual([]);
    expect(mappingProblems(byId.get('dumbbell-lateral-raise')!, 'upright-barbell-rows')).not.toEqual([]);
    expect(mappingProblems(byId.get('goblet-squat')!, 'squats-using-dumbbells')).toEqual([]); // same words: why each entry is also reviewed by eye
    expect(mappingProblems(byId.get('bulgarian-split-squat')!, 'one-leg-squat-with-barbell')).not.toEqual([]); // needs the variant
    expect(mappingProblems(byId.get('bulgarian-split-squat')!, 'one-leg-squat-with-barbell', 'withBarbell')).toEqual([]);
    expect(mappingProblems(byId.get('push-up')!, 'chest-dips', 'withoutLoad').length).toBeGreaterThan(0);
  });

  it('custom and unknown exercises have no illustration', () => {
    expect(exerciseMedia(undefined)).toBeNull();
    expect(exerciseMedia('no-such-exercise')).toBeNull();
    expect(exerciseMedia('constructor')).toBeNull();
    expect(exerciseMedia('toString')).toBeNull();
  });
});
