/**
 * Plain-language rationale text for generated programs. Kept separate so wording can change
 * without touching the selection logic. Everything here describes product defaults as defaults.
 */
import type { Equipment, Experience, Goal, LimitationArea, Prescription } from '@/domain/types';
import { WEEKDAY_SHORT } from '@/lib/dates';

export const RIR_PLAIN =
  'RIR means “reps in reserve”: stop each set with about that many reps left in the tank. RIR 2–3 = you could have done 2–3 more good reps.';

export function rirPhrase(rir: number): string {
  if (rir <= 0) return 'go close to your limit';
  if (rir === 1) return 'stop with about 1 rep left in the tank';
  return `stop with about ${rir} reps left in the tank`;
}

export const GOAL_TEXT: Record<Goal, string> = {
  build_muscle: 'build muscle',
  strength: 'get stronger',
  lose_fat: 'lose fat while keeping muscle',
  general_fitness: 'improve general fitness',
  endurance: 'improve endurance',
};

export const EXPERIENCE_TEXT: Record<Experience, string> = {
  new: 'new to lifting',
  returning: 'returning after a break',
  intermediate: 'intermediate',
  advanced: 'advanced',
};

export const EQUIPMENT_TEXT: Record<Equipment, string> = {
  barbell: 'barbell',
  rack: 'squat rack',
  bench: 'bench',
  dumbbell: 'dumbbells',
  kettlebell: 'kettlebell',
  machine: 'machines',
  cable: 'cables',
  band: 'bands',
  bodyweight: 'bodyweight',
  pullup_bar: 'pull-up bar',
  dip_station: 'dip station',
  ez_bar: 'EZ bar',
  smith: 'Smith machine',
  cardio_machine: 'cardio machines',
};

export const LIMITATION_TEXT: Record<LimitationArea, string> = {
  knee: 'knees',
  shoulder: 'shoulders',
  lower_back: 'lower back',
  hip: 'hips',
  wrist: 'wrists',
  elbow: 'elbows',
  neck: 'neck',
  ankle: 'ankles',
};

export function listText(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function weekdaysText(days: number[]): string {
  const order = [1, 2, 3, 4, 5, 6, 0];
  return listText([...days].sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((d) => WEEKDAY_SHORT[d]));
}

export function repRangeText(rx: Pick<Prescription, 'repMin' | 'repMax' | 'durationSec'>): string {
  if (rx.durationSec) return `${rx.durationSec} s`;
  return rx.repMin === rx.repMax ? `${rx.repMin}` : `${rx.repMin}–${rx.repMax}`;
}

export function prescriptionText(rx: Prescription): string {
  return `${rx.sets} × ${repRangeText(rx)} · RIR ${rx.targetRir} · rest ${restText(rx.restSec)}`;
}

export function restText(sec: number): string {
  if (sec < 60) return `${sec} s`;
  const m = sec / 60;
  return Number.isInteger(m) ? `${m} min` : `${Math.floor(m)}:${String(sec % 60).padStart(2, '0')} min`;
}

export function repsRationale(goal: Goal, experience: Experience): string {
  const experienced = experience === 'intermediate' || experience === 'advanced';
  if (goal === 'strength' && experienced)
    return 'Main lifts use lower reps (3–6) for strength, with moderate-rep secondary work and higher-rep accessories. These ranges are adjustable product defaults.';
  if (goal === 'strength')
    return 'Main lifts start at 5–8 reps so you can practise technique before going heavier; accessories use 10–15 reps. These ranges are adjustable product defaults.';
  if (goal === 'endurance')
    return 'Strength work uses moderate reps (8–12) and accessories 12–15, so it supports your activity without leaving you very sore. Adjustable product defaults.';
  return 'Most lifts use moderate rep ranges (about 8–12) and accessories 10–15 reps. Practical for building muscle. These are adjustable product defaults, not the only good choice.';
}

export function effortRationale(experience: Experience): string {
  const start = experience === 'new' || experience === 'returning' ? 3 : 2;
  return `Starting effort: ${rirPhrase(start)} (RIR ${start}). ${RIR_PLAIN}`;
}

export const CALIBRATION_RATIONALE =
  'You don’t need to know your 1-rep max. Lifts without a known comfortable load start with a light calibration session: begin light and add small jumps until a set feels like about 2–3 reps left in the tank. We never guess a starting weight from age or bodyweight.';

/* ---- per-exercise cues (generator writes them; plan screens de-duplicate them for display) */
export const WARMUP_NONE = 'No separate warm-up needed. Make the first set an easy one.';
export const WARMUP_SECONDARY = 'If these muscles haven’t worked yet today, do one lighter set of 8 first.';
export const WARMUP_ACCESSORY = 'Your first set doubles as the warm-up. Start conservatively.';
export const CALIBRATION_CUE = 'Calibration: start light and add small jumps until a set feels like about 2–3 reps left in the tank; log that as your starting load.';
export const CALIBRATION_NOTE = 'First session is a light calibration session. No 1-rep max needed.';
/** Shown once per session instead of on every exercise. */
export const SESSION_CALIBRATION_TIP = 'Lifts marked “calibrate”: start light and add small jumps until a set feels like 2–3 reps left in the tank, then log that as your starting load.';
export const SESSION_WARMUP_TIP = 'Other lifts: do one lighter set first if those muscles haven’t worked yet today; otherwise make the first set an easy one.';

/**
 * What to show on an exercise row: the warm-up cue without the repeated calibration sentence, or null
 * when it's one of the generic cues covered by the session-level tip. Custom (coach/user) text is kept.
 */
export function exerciseCue(rx: Pick<Prescription, 'warmup'>): { cue: string | null; generic: boolean } {
  const cue = (rx.warmup ?? '').replace(CALIBRATION_CUE, '').trim();
  if (!cue) return { cue: null, generic: false };
  if (cue === WARMUP_NONE || cue === WARMUP_SECONDARY || cue === WARMUP_ACCESSORY) return { cue: null, generic: true };
  return { cue, generic: false };
}
/** Exercise note worth showing on the row (the default calibration note is covered by the session tip). */
export function exerciseNote(rx: Pick<Prescription, 'notes'>): string | null {
  return rx.notes && rx.notes !== CALIBRATION_NOTE ? rx.notes : null;
}

export const DURATION_RATIONALE =
  'Estimated session times include a 5-minute general warm-up, setup, ramp-up sets and rest between sets.';

export const PROGRESSION_RATIONALE =
  'Progression uses double progression: when you reach the top of the rep range on every set at the target effort in two sessions (if you don’t log effort, we ask you to confirm it first), we suggest the smallest practical load increase and you start again near the bottom of the range.';

export function limitationRationale(limits: LimitationArea[]): string {
  return `We left out exercises that commonly load your ${listText(limits.map((l) => LIMITATION_TEXT[l]))}. This isn’t a diagnosis. If something you enjoy feels fine, you can swap it back in. If pain persists, consider a qualified professional.`;
}

export function blockRationale(weeks: number, reviewWeek: number): string {
  return `This is a ${weeks}-week block. In week ${reviewWeek} we’ll prompt a review: how sessions felt, what progressed and whether to change days or exercises.`;
}
