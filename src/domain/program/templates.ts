/**
 * Curated split definitions used by the program generator.
 *
 * A split is a list of training days; each day is an ordered list of slots. A slot describes WHAT
 * the exercise should do (movement pattern, optional target muscles, priority) and a list of
 * preferred catalog ids. The generator always selects from catalog METADATA — a preferred id is only
 * a tie-breaker and is ignored if it is missing, excluded or needs equipment the user doesn't have.
 *
 * These splits are product defaults (widely used, easy to follow), not claims of an optimal program.
 */
import type { ID, MovementPattern, MuscleGroup, SplitKey } from '@/domain/types';

export type { SplitKey };

export type Priority = 1 | 2 | 3;

export interface SlotDef {
  key: string;
  /** Plain-language role, e.g. 'Squat pattern'. */
  label: string;
  patterns: MovementPattern[];
  /** Tried (with the same muscle filter) when no exercise fits `patterns`. */
  fallbackPatterns?: MovementPattern[];
  priority: Priority;
  /** If set, the exercise's primary muscles must include one of these. */
  muscles?: MuscleGroup[];
  prefer: ID[];
}

export interface DayDef {
  key: string;
  name: string;
  focus: string;
  slots: SlotDef[];
}

export interface SplitDef {
  key: SplitKey;
  label: string;
  /** One sentence for the rationale list. */
  description: string;
  days: DayDef[];
}

/* -------------------------------------------------------- preferences */
const P = {
  squatA: ['barbell-back-squat', 'goblet-squat', 'leg-press', 'hack-squat', 'bodyweight-squat'],
  squatB: ['leg-press', 'barbell-front-squat', 'hack-squat', 'goblet-squat', 'bodyweight-squat'],
  squatC: ['goblet-squat', 'hack-squat', 'barbell-front-squat', 'leg-press', 'bodyweight-squat'],
  lungeA: ['bulgarian-split-squat', 'dumbbell-reverse-lunge', 'bodyweight-split-squat', 'dumbbell-step-up'],
  lungeB: ['walking-lunge', 'dumbbell-step-up', 'dumbbell-reverse-lunge', 'bodyweight-split-squat'],
  hingeMain: ['romanian-deadlift', 'conventional-deadlift', 'dumbbell-romanian-deadlift', 'kettlebell-swing', 'single-leg-rdl', 'glute-bridge'],
  hingeHeavy: ['conventional-deadlift', 'romanian-deadlift', 'dumbbell-romanian-deadlift', 'barbell-hip-thrust', 'single-leg-rdl', 'glute-bridge'],
  hingeSec: ['romanian-deadlift', 'dumbbell-romanian-deadlift', 'barbell-hip-thrust', 'single-leg-rdl', 'cable-pull-through', 'glute-bridge', 'back-extension'],
  hingeGlute: ['barbell-hip-thrust', 'glute-bridge', 'cable-pull-through', 'back-extension', 'kettlebell-swing', 'single-leg-rdl'],
  hpushA: ['barbell-bench-press', 'dumbbell-bench-press', 'machine-chest-press', 'push-up', 'band-chest-press', 'incline-push-up'],
  hpushB: ['incline-dumbbell-press', 'incline-barbell-press', 'dumbbell-bench-press', 'machine-chest-press', 'push-up', 'incline-push-up', 'band-chest-press'],
  hpushC: ['dumbbell-bench-press', 'machine-chest-press', 'push-up', 'dip', 'band-chest-press', 'incline-push-up'],
  vpushA: ['overhead-press', 'seated-dumbbell-shoulder-press', 'machine-shoulder-press', 'pike-push-up', 'band-overhead-press'],
  vpushB: ['seated-dumbbell-shoulder-press', 'machine-shoulder-press', 'overhead-press', 'pike-push-up', 'band-overhead-press'],
  hpullA: ['barbell-row', 'seated-cable-row', 'one-arm-dumbbell-row', 'chest-supported-dumbbell-row', 'machine-row', 'inverted-row', 'band-row'],
  hpullB: ['one-arm-dumbbell-row', 'seated-cable-row', 'chest-supported-dumbbell-row', 'machine-row', 'inverted-row', 'band-row'],
  hpullC: ['chest-supported-dumbbell-row', 'machine-row', 'seated-cable-row', 'inverted-row', 'one-arm-dumbbell-row', 'band-row'],
  vpullA: ['lat-pulldown', 'pull-up', 'assisted-pull-up', 'chin-up', 'band-pulldown'],
  vpullB: ['pull-up', 'chin-up', 'lat-pulldown', 'assisted-pull-up', 'band-pulldown'],
  lateral: ['dumbbell-lateral-raise', 'cable-lateral-raise'],
  rear: ['face-pull', 'band-pull-apart', 'rear-delt-fly'],
  chestIso: ['cable-fly'],
  biceps: ['dumbbell-curl', 'barbell-curl', 'hammer-curl', 'band-curl'],
  bicepsB: ['hammer-curl', 'barbell-curl', 'dumbbell-curl', 'band-curl'],
  triceps: ['triceps-pushdown', 'overhead-dumbbell-triceps-extension', 'skull-crusher', 'band-triceps-pushdown'],
  tricepsB: ['overhead-dumbbell-triceps-extension', 'skull-crusher', 'triceps-pushdown', 'band-triceps-pushdown'],
  hams: ['lying-leg-curl', 'seated-leg-curl'],
  quads: ['leg-extension'],
  calves: ['standing-calf-raise', 'seated-calf-raise'],
  trunkA: ['plank', 'dead-bug', 'cable-pallof-press', 'band-pallof-press', 'bird-dog'],
  trunkB: ['side-plank', 'cable-pallof-press', 'band-pallof-press', 'bird-dog', 'dead-bug'],
  trunkC: ['hanging-knee-raise', 'dead-bug', 'plank', 'farmer-carry'],
  carry: ['farmer-carry'],
} satisfies Record<string, ID[]>;

/* ------------------------------------------------------ slot helpers */
const squat = (priority: Priority, prefer: ID[], key = 'squat'): SlotDef => ({ key, label: 'Squat pattern', patterns: ['squat'], fallbackPatterns: ['lunge'], priority, prefer });
const lunge = (priority: Priority, prefer: ID[], key = 'lunge'): SlotDef => ({ key, label: 'Single-leg', patterns: ['lunge'], fallbackPatterns: ['squat'], priority, prefer });
const hinge = (priority: Priority, prefer: ID[], key = 'hinge'): SlotDef => ({ key, label: 'Hip hinge', patterns: ['hinge'], priority, prefer });
const hpush = (priority: Priority, prefer: ID[], key = 'hpush'): SlotDef => ({ key, label: 'Horizontal push', patterns: ['horizontal_push'], priority, prefer });
const vpush = (priority: Priority, prefer: ID[], key = 'vpush'): SlotDef => ({ key, label: 'Vertical push', patterns: ['vertical_push'], priority, prefer });
const hpull = (priority: Priority, prefer: ID[], key = 'hpull'): SlotDef => ({ key, label: 'Horizontal pull', patterns: ['horizontal_pull'], priority, prefer });
const vpull = (priority: Priority, prefer: ID[], key = 'vpull'): SlotDef => ({ key, label: 'Vertical pull', patterns: ['vertical_pull'], priority, prefer });
const trunk = (prefer: ID[], key = 'trunk'): SlotDef => ({ key, label: 'Trunk', patterns: ['trunk'], fallbackPatterns: ['carry'], priority: 3, prefer });
const iso = (key: string, label: string, muscles: MuscleGroup[], prefer: ID[], lower = false, fallback?: MovementPattern[]): SlotDef => ({
  key,
  label,
  patterns: [lower ? 'isolation_lower' : 'isolation_upper'],
  fallbackPatterns: fallback,
  muscles,
  priority: 3,
  prefer,
});
const lateral = () => iso('lateral', 'Side shoulders', ['shoulders'], P.lateral);
const rear = () => iso('rear', 'Rear shoulders & upper back', ['rear_delts', 'upper_back'], P.rear, false, ['horizontal_pull']);
const biceps = (prefer = P.biceps) => iso('biceps', 'Biceps', ['biceps'], prefer);
const triceps = (prefer = P.triceps) => iso('triceps', 'Triceps', ['triceps'], prefer);
const hams = () => iso('hams', 'Hamstrings', ['hamstrings'], P.hams, true, ['hinge']);
const quads = () => iso('quads', 'Quads', ['quads'], P.quads, true);
const calves = () => iso('calves', 'Calves', ['calves'], P.calves, true);
const chestIso = () => iso('chestiso', 'Chest', ['chest'], P.chestIso);

/* -------------------------------------------------------------- days */
const FB1: DayDef = {
  key: 'fb',
  name: 'Full body',
  focus: 'Full body',
  slots: [squat(1, P.squatA), hpush(1, P.hpushA), hinge(2, P.hingeSec), hpull(2, P.hpullA), vpull(2, P.vpullA), vpush(3, P.vpushB), trunk(P.trunkA)],
};
const FB_A: DayDef = {
  key: 'a',
  name: 'Full body A',
  focus: 'Full body',
  slots: [squat(1, P.squatA), hpush(1, P.hpushA), hpull(2, P.hpullA), hinge(2, P.hingeSec), lateral(), trunk(P.trunkA)],
};
const FB_B: DayDef = {
  key: 'b',
  name: 'Full body B',
  focus: 'Full body',
  slots: [hinge(1, P.hingeMain), vpush(1, P.vpushA), vpull(2, P.vpullA), lunge(2, P.lungeA), biceps(), trunk(P.trunkB)],
};
const FB_C: DayDef = {
  key: 'c',
  name: 'Full body C',
  focus: 'Full body',
  slots: [squat(1, P.squatB), hpush(1, P.hpushB), hpull(2, P.hpullC), hinge(2, P.hingeGlute), triceps(), trunk(P.trunkC)],
};
/** 2-day A/B covers vertical patterns too, since there's no C day. */
const FB2_A: DayDef = { ...FB_A, slots: [squat(1, P.squatA), hpush(1, P.hpushA), hpull(2, P.hpullA), hinge(2, P.hingeSec), vpush(3, P.vpushB), trunk(P.trunkA)] };
const FB2_B: DayDef = { ...FB_B, slots: [hinge(1, P.hingeMain), vpush(1, P.vpushA), vpull(2, P.vpullA), lunge(2, P.lungeA), hpush(3, P.hpushC, 'hpush2'), trunk(P.trunkB)] };

const UPPER_A: DayDef = {
  key: 'ua',
  name: 'Upper A',
  focus: 'Upper body',
  slots: [hpush(1, P.hpushA), hpull(1, P.hpullA), vpush(2, P.vpushB), vpull(2, P.vpullA), lateral(), triceps(), biceps()],
};
const UPPER_B: DayDef = {
  key: 'ub',
  name: 'Upper B',
  focus: 'Upper body',
  slots: [vpush(1, P.vpushA), vpull(1, P.vpullB), hpush(2, P.hpushB), hpull(2, P.hpullB), rear(), biceps(P.bicepsB), triceps(P.tricepsB)],
};
const LOWER_A: DayDef = {
  key: 'la',
  name: 'Lower A',
  focus: 'Lower body',
  slots: [squat(1, P.squatA), hinge(2, P.hingeSec), lunge(2, P.lungeA), hams(), calves(), trunk(P.trunkA)],
};
const LOWER_B: DayDef = {
  key: 'lb',
  name: 'Lower B',
  focus: 'Lower body',
  slots: [hinge(1, P.hingeHeavy), squat(2, P.squatB), lunge(2, P.lungeB), quads(), calves(), trunk(P.trunkC)],
};
const PUSH_A: DayDef = {
  key: 'pa',
  name: 'Push A',
  focus: 'Chest, shoulders, triceps',
  slots: [hpush(1, P.hpushA), vpush(2, P.vpushB), hpush(2, P.hpushB, 'hpush2'), lateral(), triceps(), chestIso()],
};
const PULL_A: DayDef = {
  key: 'pla',
  name: 'Pull A',
  focus: 'Back, rear shoulders, biceps',
  slots: [vpull(1, P.vpullA), hpull(1, P.hpullA), hpull(2, P.hpullC, 'hpull2'), rear(), biceps(), trunk(P.trunkC)],
};
const LEGS_A: DayDef = {
  key: 'lga',
  name: 'Legs A',
  focus: 'Legs & trunk',
  slots: [squat(1, P.squatA), hinge(2, P.hingeSec), lunge(2, P.lungeA), hams(), calves(), trunk(P.trunkA)],
};
const PUSH_B: DayDef = {
  key: 'pb',
  name: 'Push B',
  focus: 'Shoulders, chest, triceps',
  slots: [vpush(1, P.vpushA), hpush(2, P.hpushB), hpush(2, P.hpushC, 'hpush2'), lateral(), triceps(P.tricepsB)],
};
const PULL_B: DayDef = {
  key: 'plb',
  name: 'Pull B',
  focus: 'Back, rear shoulders, biceps',
  slots: [hpull(1, P.hpullB), vpull(1, P.vpullB), hpull(2, P.hpullA, 'hpull2'), rear(), biceps(P.bicepsB), trunk(P.trunkB)],
};
const LEGS_B: DayDef = {
  key: 'lgb',
  name: 'Legs B',
  focus: 'Legs & trunk',
  slots: [hinge(1, P.hingeHeavy), squat(2, P.squatB), lunge(2, P.lungeB), quads(), calves(), trunk(P.trunkC)],
};
const FULL_C: DayDef = { ...FB_C, key: 'f', name: 'Full body', focus: 'Full body' };
/** 4th full-body day: same jobs as the 2-day B session; the week-level "already used" penalty picks different exercises. */
const FB_D: DayDef = { ...FB2_B, key: 'd', name: 'Full body D' };
/** 3rd upper/lower pair for 6 days; the week-level penalty varies the exercises from the A sessions. */
const UPPER_C: DayDef = { ...UPPER_A, key: 'uc', name: 'Upper C' };
const LOWER_C: DayDef = { ...LOWER_A, key: 'lc', name: 'Lower C' };

const ES_A: DayDef = {
  key: 'sa',
  name: 'Strength A',
  focus: 'Supporting strength',
  slots: [squat(1, P.squatC), hinge(2, P.hingeSec), hpull(2, P.hpullB), hpush(2, P.hpushC), calves(), trunk(P.trunkA)],
};
const ES_B: DayDef = {
  key: 'sb',
  name: 'Strength B',
  focus: 'Supporting strength',
  slots: [lunge(1, P.lungeB), hinge(2, P.hingeGlute), vpull(2, P.vpullA), vpush(3, P.vpushB), trunk(P.trunkB), { key: 'carry', label: 'Carry', patterns: ['carry'], fallbackPatterns: ['trunk'], priority: 3, prefer: P.carry }],
};

export const SPLITS: Record<SplitKey, SplitDef> = {
  fb1: { key: 'fb1', label: 'Full-body session', description: 'One full-body session that practises every major movement pattern.', days: [FB1] },
  fb2: { key: 'fb2', label: 'Full-body A/B', description: 'Two full-body sessions (A and B) so each major muscle group is trained twice a week.', days: [FB2_A, FB2_B] },
  fb3: { key: 'fb3', label: 'Full-body A/B/C', description: 'Three full-body sessions (A, B, C). Frequent practice of the main lifts with fewer exercises per session.', days: [FB_A, FB_B, FB_C] },
  fb4: { key: 'fb4', label: 'Full-body ×4', description: 'Four shorter full-body sessions. Every main lift practised often, with fewer exercises per session.', days: [FB_A, FB_B, FB_C, FB_D] },
  ul2: { key: 'ul2', label: 'Upper / Lower', description: 'One upper-body and one lower-body session. More work per muscle each session, each muscle group trained once a week.', days: [UPPER_A, LOWER_A] },
  ppl3: { key: 'ppl3', label: 'Push / Pull / Legs', description: 'A push, a pull and a legs day. Lots of work per muscle group, each trained once a week.', days: [PUSH_A, PULL_A, LEGS_A] },
  ulf: { key: 'ulf', label: 'Upper / Lower / Full body', description: 'An upper, a lower and a full-body day. More volume per muscle per session for experienced lifters.', days: [UPPER_A, LOWER_A, FULL_C] },
  ul4: { key: 'ul4', label: 'Upper / Lower ×2', description: 'Upper and lower sessions repeated twice, so each muscle group is trained twice a week with room to recover.', days: [UPPER_A, LOWER_A, UPPER_B, LOWER_B] },
  ulppl: { key: 'ulppl', label: 'Upper / Lower + Push / Pull / Legs', description: 'An upper/lower pair plus push, pull and legs days. High frequency for experienced lifters.', days: [UPPER_A, LOWER_A, PUSH_A, PULL_A, LEGS_B] },
  ul5: { key: 'ul5', label: 'Upper / Lower ×2 + Full body', description: 'Two upper/lower pairs plus a full-body day. Twice-weekly frequency with an extra practice day for the main lifts.', days: [UPPER_A, LOWER_A, UPPER_B, LOWER_B, FULL_C] },
  ul6: { key: 'ul6', label: 'Upper / Lower ×3', description: 'Upper and lower sessions three times each. High frequency with moderate work per session.', days: [UPPER_A, LOWER_A, UPPER_B, LOWER_B, UPPER_C, LOWER_C] },
  ppl6: { key: 'ppl6', label: 'Push / Pull / Legs ×2', description: 'Push, pull and legs repeated twice a week. High frequency and volume for experienced lifters.', days: [PUSH_A, PULL_A, LEGS_A, PUSH_B, PULL_B, LEGS_B] },
  es: { key: 'es', label: 'Supporting strength', description: 'Short full-body strength sessions that support your main activity (legs, hips, trunk and posture).', days: [ES_A, ES_B] },
};

/** Mobility flow used on easy days. */
export const MOBILITY_PREFER: ID[] = ['worlds-greatest-stretch', 'cat-cow', 'thoracic-rotation', 'bird-dog', 'dead-bug', 'glute-bridge'];
/** Conditioning circuit preferences. */
export const CONDITIONING_PREFER: ID[] = ['rowing-machine', 'stationary-bike', 'kettlebell-swing', 'mountain-climber', 'farmer-carry'];

/** Movement groups that should appear across the week. */
export const COVERAGE_GROUPS: { key: string; label: string; patterns: MovementPattern[] }[] = [
  { key: 'squat', label: 'squat or lunge', patterns: ['squat', 'lunge'] },
  { key: 'hinge', label: 'hip hinge', patterns: ['hinge'] },
  { key: 'hpush', label: 'horizontal push', patterns: ['horizontal_push'] },
  { key: 'vpush', label: 'vertical push', patterns: ['vertical_push'] },
  { key: 'hpull', label: 'horizontal pull', patterns: ['horizontal_pull'] },
  { key: 'vpull', label: 'vertical pull', patterns: ['vertical_pull'] },
  { key: 'trunk', label: 'trunk', patterns: ['trunk', 'carry'] },
];

/** Major muscle groups we aim to train about twice a week when feasible. */
export const MAJOR_MUSCLES: { key: string; label: string; muscles: MuscleGroup[] }[] = [
  { key: 'chest', label: 'Chest', muscles: ['chest'] },
  { key: 'back', label: 'Back', muscles: ['upper_back', 'lats'] },
  { key: 'shoulders', label: 'Shoulders', muscles: ['shoulders'] },
  { key: 'quads', label: 'Quads', muscles: ['quads'] },
  { key: 'posterior', label: 'Glutes & hamstrings', muscles: ['glutes', 'hamstrings'] },
];
