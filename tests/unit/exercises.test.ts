import { describe, expect, it } from 'vitest';
import { EXERCISES } from '@/data/exercises';
import { loadConventionNote, MUSCLE_LABELS, EQUIPMENT_LABELS, PATTERN_LABELS, TRACKING_LABELS, searchExercises } from '@/data/exerciseMeta';
import type { Equipment, Exercise, MovementPattern } from '@/domain/types';

const REQUIRED = `
barbell-back-squat barbell-front-squat goblet-squat leg-press hack-squat bodyweight-squat bulgarian-split-squat
dumbbell-reverse-lunge walking-lunge dumbbell-step-up bodyweight-split-squat
conventional-deadlift romanian-deadlift dumbbell-romanian-deadlift single-leg-rdl barbell-hip-thrust glute-bridge
kettlebell-swing back-extension cable-pull-through
barbell-bench-press dumbbell-bench-press incline-dumbbell-press incline-barbell-press push-up incline-push-up
machine-chest-press cable-fly band-chest-press dip weighted-dip
overhead-press seated-dumbbell-shoulder-press machine-shoulder-press pike-push-up band-overhead-press
barbell-row one-arm-dumbbell-row seated-cable-row chest-supported-dumbbell-row machine-row inverted-row band-row
pull-up chin-up weighted-pull-up assisted-pull-up lat-pulldown band-pulldown straight-arm-pulldown
dumbbell-lateral-raise cable-lateral-raise face-pull band-pull-apart rear-delt-fly dumbbell-curl barbell-curl
hammer-curl band-curl triceps-pushdown overhead-dumbbell-triceps-extension skull-crusher band-triceps-pushdown
leg-extension lying-leg-curl seated-leg-curl standing-calf-raise seated-calf-raise band-lateral-walk
plank side-plank dead-bug bird-dog hanging-knee-raise cable-pallof-press band-pallof-press farmer-carry
rowing-machine stationary-bike mountain-climber worlds-greatest-stretch cat-cow thoracic-rotation
`.split(/\s+/).filter(Boolean);

const byId = new Map(EXERCISES.map((e) => [e.id, e]));
const get = (id: string) => byId.get(id)!;

/** Patterns that are reasonable stand-ins for each other in a substitution. */
const COMPATIBLE: Record<MovementPattern, MovementPattern[]> = {
  squat: ['squat', 'lunge', 'isolation_lower'],
  lunge: ['lunge', 'squat', 'isolation_lower'],
  hinge: ['hinge', 'isolation_lower'],
  isolation_lower: ['isolation_lower', 'squat', 'lunge', 'hinge'],
  horizontal_push: ['horizontal_push', 'vertical_push', 'isolation_upper'],
  vertical_push: ['vertical_push', 'horizontal_push', 'isolation_upper'],
  horizontal_pull: ['horizontal_pull', 'vertical_pull', 'isolation_upper'],
  vertical_pull: ['vertical_pull', 'horizontal_pull', 'isolation_upper'],
  isolation_upper: ['isolation_upper', 'horizontal_push', 'vertical_push', 'horizontal_pull', 'vertical_pull'],
  trunk: ['trunk', 'carry'],
  carry: ['carry', 'trunk'],
  conditioning: ['conditioning'],
  mobility: ['mobility'],
};

const sameSet = (a: Equipment[], b: Equipment[]) => a.length === b.length && a.every((x) => b.includes(x));

describe('exercise catalog integrity', () => {
  it('has at least 60 exercises with unique ids', () => {
    expect(EXERCISES.length).toBeGreaterThanOrEqual(60);
    expect(new Set(EXERCISES.map((e) => e.id)).size).toBe(EXERCISES.length);
    expect(new Set(EXERCISES.map((e) => e.name.toLowerCase())).size).toBe(EXERCISES.length);
  });

  it('contains every required id', () => {
    const missing = REQUIRED.filter((id) => !byId.has(id));
    expect(missing).toEqual([]);
  });

  it('fills every field', () => {
    for (const e of EXERCISES) {
      const ctx = e.id;
      expect(e.id, ctx).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(e.name.length, ctx).toBeGreaterThan(2);
      expect(Array.isArray(e.aliases), ctx).toBe(true);
      expect(e.primaryMuscles.length, ctx).toBeGreaterThan(0);
      expect(e.equipment.length, ctx).toBeGreaterThan(0);
      expect(e.setup.length, ctx).toBeGreaterThan(30);
      expect(e.execution.length, ctx).toBeGreaterThan(30);
      expect(e.cues.length, ctx).toBeGreaterThanOrEqual(2);
      expect(e.cues.length, ctx).toBeLessThanOrEqual(4);
      expect(e.mistakes.length, ctx).toBeGreaterThanOrEqual(2);
      expect(e.mistakes.length, ctx).toBeLessThanOrEqual(3);
      expect(e.referenceUrl, ctx).toBeUndefined();
      expect(e.custom, ctx).toBeUndefined();
      for (const m of [...e.primaryMuscles, ...e.secondaryMuscles]) expect(MUSCLE_LABELS[m], ctx).toBeTruthy();
      for (const q of e.equipment) expect(EQUIPMENT_LABELS[q], ctx).toBeTruthy();
      expect(PATTERN_LABELS[e.pattern], ctx).toBeTruthy();
      expect(TRACKING_LABELS[e.tracking], ctx).toBeTruthy();
      expect(e.primaryMuscles.filter((m) => e.secondaryMuscles.includes(m)), ctx).toEqual([]);
      if (e.equipment.includes('bodyweight')) expect(e.equipment, ctx).toEqual(['bodyweight']);
    }
  });

  it('has 2–5 substitutions that resolve, are compatible, and include different equipment', () => {
    for (const e of EXERCISES) {
      expect(e.substitutions.length, e.id).toBeGreaterThanOrEqual(2);
      expect(e.substitutions.length, e.id).toBeLessThanOrEqual(5);
      expect(new Set(e.substitutions).size, e.id).toBe(e.substitutions.length);
      expect(e.substitutions, e.id).not.toContain(e.id);
      for (const s of e.substitutions) {
        const sub = byId.get(s);
        expect(sub, `${e.id} → ${s}`).toBeDefined();
        expect(COMPATIBLE[e.pattern], `${e.id} → ${s} (${sub!.pattern})`).toContain(sub!.pattern);
      }
      if (e.pattern !== 'mobility') {
        const differentEquipment = e.substitutions.some((s) => !sameSet(get(s).equipment, e.equipment));
        expect(differentEquipment, e.id).toBe(true);
      }
    }
  });

  it('applies tracking and load conventions consistently', () => {
    for (const e of EXERCISES) {
      const ctx = e.id;
      switch (e.tracking) {
        case 'weight_reps':
          expect(['total', 'per_hand', 'stack'], ctx).toContain(e.load);
          break;
        case 'reps':
          expect(e.load, ctx).toBe('none');
          break;
        case 'bodyweight_plus':
          expect(e.load, ctx).toBe('added');
          break;
        case 'assisted':
          expect(e.load, ctx).toBe('assistance');
          break;
        case 'duration':
          expect(e.load, ctx).toBe('none');
          break;
        case 'distance_time':
          expect(['none', 'per_hand', 'total'], ctx).toContain(e.load);
          break;
      }
      if (e.load === 'per_hand') expect([1, 2], ctx).toContain(e.implements);
      if (e.load === 'per_hand' && e.implements === 1) expect(e.unilateral, ctx).toBe(true);
      if (e.load !== 'none') expect(e.increment, ctx).toBeDefined();
      else expect(e.increment, ctx).toBeUndefined();
      if (e.load === 'stack') expect(e.equipment.some((q) => q === 'machine' || q === 'cable'), ctx).toBe(true);
      if (e.mainLift) expect(e.category, ctx).toBe('compound');
    }
  });

  it('encodes the documented conventions for key exercises', () => {
    expect(get('barbell-bench-press').equipment.sort()).toEqual(['barbell', 'bench', 'rack']);
    expect(get('pull-up').equipment).toEqual(['pullup_bar']);
    expect(get('plank').tracking).toBe('duration');
    expect(get('side-plank').tracking).toBe('duration');
    for (const id of ['worlds-greatest-stretch', 'cat-cow']) expect(get(id).tracking).toBe('duration');
    for (const id of ['farmer-carry', 'rowing-machine', 'stationary-bike']) expect(get(id).tracking).toBe('distance_time');
    expect(get('assisted-pull-up')).toMatchObject({ tracking: 'assisted', load: 'assistance' });
    expect(get('weighted-dip')).toMatchObject({ tracking: 'bodyweight_plus', load: 'added' });
    expect(get('weighted-pull-up')).toMatchObject({ tracking: 'bodyweight_plus', load: 'added' });
    for (const id of ['push-up', 'pull-up', 'chin-up', 'dip']) expect(get(id)).toMatchObject({ tracking: 'reps', load: 'none' });
    expect(get('dumbbell-bench-press')).toMatchObject({ load: 'per_hand', implements: 2 });
    expect(get('one-arm-dumbbell-row')).toMatchObject({ load: 'per_hand', implements: 1, unilateral: true });
    expect(get('lat-pulldown').load).toBe('stack');
    expect(get('barbell-back-squat').load).toBe('total');
    expect(get('barbell-back-squat').increment).toEqual({ kg: 2.5, lb: 5 });
    expect(get('dumbbell-bench-press').increment).toEqual({ kg: 2, lb: 5 });
    expect(get('machine-chest-press').increment).toEqual({ kg: 5, lb: 10 });
  });

  describe('every program pattern has options for each equipment profile', () => {
    const ALL_EQUIPMENT = Object.keys(EQUIPMENT_LABELS) as Equipment[];
    const PROFILES: Record<string, Equipment[]> = {
      'full gym': ALL_EQUIPMENT,
      'dumbbells only': ['dumbbell', 'bodyweight'],
      'bodyweight only': ['bodyweight'],
      bands: ['band', 'bodyweight'],
    };
    const SLOTS: Record<string, MovementPattern[]> = {
      'squat or lunge': ['squat', 'lunge'],
      hinge: ['hinge'],
      'horizontal push': ['horizontal_push'],
      'vertical push': ['vertical_push'],
      'horizontal pull': ['horizontal_pull'],
      'vertical pull': ['vertical_pull'],
      trunk: ['trunk'],
    };
    const doable = (e: Exercise, eq: Equipment[]) => e.equipment.every((q) => eq.includes(q));
    for (const [profile, eq] of Object.entries(PROFILES)) {
      for (const [slot, patterns] of Object.entries(SLOTS)) {
        it(`${profile}: ${slot}`, () => {
          const options = EXERCISES.filter((e) => patterns.includes(e.pattern) && doable(e, eq));
          expect(options.length).toBeGreaterThan(0);
        });
      }
    }
    it('full gym and dumbbells have a main lift for each lower/push/pull slot', () => {
      for (const eq of [ALL_EQUIPMENT, ['dumbbell', 'bench', 'bodyweight'] as Equipment[]]) {
        for (const patterns of [['squat', 'lunge'], ['hinge'], ['horizontal_push'], ['vertical_push'], ['horizontal_pull']] as MovementPattern[][]) {
          expect(EXERCISES.some((e) => e.mainLift && patterns.includes(e.pattern) && doable(e, eq)), patterns.join()).toBe(true);
        }
      }
    });
  });
});

describe('loadConventionNote', () => {
  it('explains per-hand dumbbells and per-side reps', () => {
    expect(loadConventionNote(get('dumbbell-bench-press'))).toMatch(/per hand/i);
    const bss = loadConventionNote(get('bulgarian-split-squat'))!;
    expect(bss).toMatch(/per hand/i);
    expect(bss).toMatch(/per side/i);
    expect(loadConventionNote(get('one-arm-dumbbell-row'))).toMatch(/single dumbbell.*per side/i);
  });
  it('explains bar, stack, added and assistance loads', () => {
    expect(loadConventionNote(get('barbell-back-squat'))).toMatch(/including the bar/i);
    expect(loadConventionNote(get('lat-pulldown'))).toMatch(/stack/i);
    expect(loadConventionNote(get('weighted-dip'))).toMatch(/added weight/i);
    expect(loadConventionNote(get('assisted-pull-up'))).toMatch(/less assistance/i);
    expect(loadConventionNote(get('side-plank'))).toMatch(/per side/i);
  });
  it('returns null when nothing needs explaining', () => {
    expect(loadConventionNote(get('push-up'))).toBeNull();
  });
});

describe('searchExercises', () => {
  const ids = (q: string, f?: Parameters<typeof searchExercises>[2]) => searchExercises(EXERCISES, q, f).map((e) => e.id);

  it('returns everything (sorted by name) for an empty query', () => {
    const r = searchExercises(EXERCISES, '   ');
    expect(r.length).toBe(EXERCISES.length);
    const names = r.map((e) => e.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('ranks name prefix above name contains above alias above muscle/equipment', () => {
    const r = ids('pull');
    expect(r[0]).toBe('pull-up');
    // name contains
    expect(r.indexOf('band-pull-apart')).toBeGreaterThan(0);
    // "Australian pull-up" is only an alias of the inverted row
    expect(r.indexOf('band-pull-apart')).toBeLessThan(r.indexOf('inverted-row'));
    const bench = ids('bench');
    const firstEquipmentOnly = bench.findIndex((id) => !get(id).name.toLowerCase().includes('bench') && !get(id).aliases.some((a) => a.toLowerCase().includes('bench')));
    const lastNameMatch = Math.max(...bench.map((id, i) => (get(id).name.toLowerCase().includes('bench') ? i : -1)));
    expect(lastNameMatch).toBeGreaterThanOrEqual(0);
    expect(firstEquipmentOnly).toBeGreaterThan(lastNameMatch);
    // alias-only matches come after name matches
    const ohp = ids('military');
    expect(ohp[0]).toBe('overhead-press');
    const press = ids('press');
    const firstAliasOnly = press.findIndex((id) => !get(id).name.toLowerCase().includes('press'));
    const lastNamePress = Math.max(...press.map((id, i) => (get(id).name.toLowerCase().includes('press') ? i : -1)));
    expect(firstAliasOnly).toBeGreaterThan(lastNamePress);
  });

  it('is case- and diacritic-insensitive', () => {
    expect(ids('RÓMANIAN DEADLIFT')[0]).toBe('romanian-deadlift');
    expect(ids('wörld')).toContain('worlds-greatest-stretch');
    expect(ids("world's greatest")).toContain('worlds-greatest-stretch');
  });

  it('matches aliases', () => {
    const r = ids('rdl');
    expect(r).toContain('romanian-deadlift');
    expect(r).toContain('dumbbell-romanian-deadlift');
    expect(ids('ohp')[0]).toBe('overhead-press');
  });

  it('matches muscles, equipment and movement pattern', () => {
    expect(ids('hamstrings')).toContain('lying-leg-curl');
    expect(ids('lower back')).toContain('back-extension');
    expect(ids('kettlebell')).toContain('kettlebell-swing');
    expect(ids('dumbbells')).toContain('goblet-squat');
    expect(ids('vertical pull')).toContain('lat-pulldown');
    expect(ids('hinge')).toContain('conventional-deadlift');
  });

  it('supports multi-word queries across fields', () => {
    expect(ids('dumbbell row')).toContain('one-arm-dumbbell-row');
    expect(ids('band chest')).toContain('band-chest-press');
    expect(ids('cable triceps')).toContain('triceps-pushdown');
    expect(ids('zzzz')).toEqual([]);
  });

  it('applies filters', () => {
    const bands = searchExercises(EXERCISES, '', { equipment: 'band' });
    expect(bands.length).toBeGreaterThan(5);
    expect(bands.every((e) => e.equipment.includes('band'))).toBe(true);
    const hinge = searchExercises(EXERCISES, '', { pattern: 'hinge' });
    expect(hinge.every((e) => e.pattern === 'hinge')).toBe(true);
    const chest = searchExercises(EXERCISES, '', { muscle: 'chest' });
    expect(chest.every((e) => e.primaryMuscles.includes('chest') || e.secondaryMuscles.includes('chest'))).toBe(true);
    // primary-muscle matches come first
    const firstSecondary = chest.findIndex((e) => !e.primaryMuscles.includes('chest'));
    if (firstSecondary >= 0) expect(chest.slice(firstSecondary).every((e) => !e.primaryMuscles.includes('chest'))).toBe(true);
    expect(ids('press', { equipment: 'machine' })).toEqual(expect.arrayContaining(['machine-chest-press', 'machine-shoulder-press']));
    expect(ids('press', { equipment: 'machine' })).not.toContain('barbell-bench-press');
  });
});
