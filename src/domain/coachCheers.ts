/**
 * Coach cheers in the workout logger (pure; no React, no network, no AI call — works offline at zero cost).
 *
 *  - cheerForSet: after a set is ticked done, decide the situation from the set just logged (new record,
 *    last set of the workout, top of the rep range, reps below target, last set of an exercise, or general)
 *    and pick one short line (≤ 12 words) in the user's coach style.
 *  - restOverCheer: when the rest timer ends, name the next set ("Rest's up, Bench press set 3: 60 kg × 8. Let's go!").
 *
 * Rules: warm-up sets get nothing; an exercise flagged "Felt discomfort" only ever gets caring lines; never a line
 * about body weight or food; the same line is never picked twice in a row (pass the previous line as `last`).
 */
import type { CoachStyle, Exercise, ID, LoggedSet, SessionExercise, WeightUnit, WorkoutSession } from './types';
import { detectRecords } from './stats';
import { formatWeight } from './units';

export type CheerSituation = 'pr' | 'top_of_range' | 'last_set_exercise' | 'last_set_workout' | 'below_target' | 'general' | 'discomfort' | 'rest_over' | 'rest_over_discomfort';

type Lines = Record<CoachStyle, string[]>;

/**
 * {record} = the record ("60 kg × 8"), {next} = next exercise name, {set} = next set description.
 * Each list has 15+ lines; every line stays ≤ 12 words with typical names filled in.
 */
export const CHEER_LINES: Record<CheerSituation, Lines> = {
  pr: {
    supportive: [
      'New record: {record}! So proud of you.',
      '{record}, a new best! Lovely work.',
      'Look at that, {record}. A personal record!',
      'New PR: {record}. Your hard work is paying off.',
      '{record}! That’s a new best for you.',
      'A new record, {record}. Enjoy this moment!',
      'You did it, {record}. New personal best!',
      'New best: {record}. Steady progress, beautifully done.',
      '{record}, record set. Be proud of that one.',
      'Personal record: {record}. You earned it.',
      'That’s a new best, {record}. Wonderful!',
      'New PR at {record}. Keep being kind to yourself.',
      '{record}! Progress looks good on you.',
      'Record time: {record}. Really well done.',
      'A new high, {record}. Lovely effort today.',
      '{record}: new personal best. Nicely done!',
    ],
    balanced: [
      'New PR: {record}! Great work.',
      '{record}, that’s a new record!',
      'Record broken: {record}. Nice!',
      'New best: {record}. Strong set!',
      '{record}! New personal record, let’s go.',
      'PR alert: {record}. Well earned.',
      'That’s a PR, {record}. Keep it rolling.',
      '{record}, new best. The work is paying off!',
      'New record at {record}. Love it!',
      'Personal best: {record}. Brilliant.',
      'Boom, {record}. New PR!',
      '{record} is a new record. Great lifting!',
      'New high: {record}. Keep that momentum.',
      'PR on the board: {record}!',
      '{record}! That’s progress you can see.',
      'Fresh PR: {record}. Nicely done.',
    ],
    strict: [
      'New PR: {record}. That’s what consistency buys.',
      '{record}. Record broken. Now back it up.',
      'PR: {record}. Good. Stay hungry.',
      '{record}, new best. This is the standard now.',
      'Record set: {record}. Don’t get comfortable.',
      'New PR, {record}. Earned it. Keep working.',
      '{record}. That’s a record. Next set, same focus.',
      'PR at {record}. That’s how it’s done.',
      'New best: {record}. Raise the bar again.',
      '{record}! Record. Now finish the job.',
      'Personal record: {record}. Discipline pays.',
      'That’s a PR, {record}. No slowing down.',
      '{record}. New best. Keep stacking wins.',
      'PR locked in: {record}. Stay sharp.',
      'Record: {record}. You set the new floor.',
      '{record}. New PR. Respect. Keep going.',
    ],
  },
  top_of_range: {
    supportive: [
      'That’s the top of the range, weight goes up next time.',
      'Top of the range! You’re ready for a bit more next time.',
      'All the reps you aimed for. Next time, a little heavier.',
      'Top of your range, lovely. Small step up next session.',
      'You hit the top reps. Time to add a little weight soon.',
      'Every rep you planned, and then some. Nicely done.',
      'Top of the range, you’re getting stronger.',
      'Max reps reached! A small increase is coming next time.',
      'You topped out the range. Gentle step up next session.',
      'Top reps hit. Your body is adapting beautifully.',
      'Full range done. Next time we nudge the weight.',
      'That’s the top of the range. Well earned.',
      'All reps in. You’re ready to progress.',
      'Top of the range again, steady progress.',
      'Top reps! Next session, slightly heavier.',
    ],
    balanced: [
      'That’s the top of the range, weight goes up next time.',
      'Top of the range! Add weight next session.',
      'Max reps hit. Time to go heavier next time.',
      'Range topped out. Load goes up next workout.',
      'Top reps, nice! Next time, a bit more weight.',
      'You owned that range. Heavier next time.',
      'Top of the range, progress unlocked.',
      'All reps done. Next session, bump the weight.',
      'That’s the ceiling of the range. Time to raise it.',
      'Top reps! The weight should move up next time.',
      'Range maxed. Earned yourself a heavier set.',
      'Top of the range. That’s how progress happens.',
      'Full reps! Next time, a small jump in weight.',
      'You hit the top. Weight goes up soon.',
      'Top of the range again, nice and solid.',
    ],
    strict: [
      'That’s the top of the range, weight goes up next time.',
      'Top of the range. Too easy, go heavier next time.',
      'Max reps. Next session, more weight. No hesitation.',
      'Range topped. Time to earn the next plate.',
      'Top reps. You’ve outgrown this weight.',
      'All reps in. Add load next time, no excuses.',
      'Top of the range. Raise the bar next session.',
      'Range done. Comfortable means it’s time to go heavier.',
      'Top reps. Next time the weight goes up.',
      'That’s the top. Stop coasting, add weight next time.',
      'Max reps hit. Heavier next session, that’s the deal.',
      'Top of the range. Progress demands more weight.',
      'Full reps. Next workout, step up the load.',
      'You topped it. Now make the next one harder.',
      'Range maxed. Heavier is the only direction.',
    ],
  },
  last_set_exercise: {
    supportive: [
      'Lovely, that’s it for this one. {next} is next.',
      'All sets done here. Take your time, then {next}.',
      'Nicely finished. Next up: {next}.',
      'That exercise is done. {next} when you’re ready.',
      'Well done! Moving on to {next}.',
      'All done here. Gently on to {next}.',
      'Great job on that one. {next} next.',
      'Finished! Have a sip of water, then {next}.',
      'That’s a wrap on this one. On to {next}.',
      'Every set done. {next} is waiting for you.',
      'Lovely work. Next: {next}.',
      'One exercise down! {next} up next.',
      'Nicely done. Ready for {next} when you are.',
      'Done and dusted. Let’s try {next}.',
      'That’s all for this one. {next} next, at your pace.',
    ],
    balanced: [
      'Exercise done! Next up: {next}.',
      'All sets in. On to {next}.',
      'That’s a wrap. {next} is next.',
      'Nice work. Head to {next}.',
      'Done here! Time for {next}.',
      'Finished that one. Let’s go, {next}.',
      'All sets done. Next: {next}.',
      'One down! {next} up next.',
      'Good stuff. Move on to {next}.',
      'Completed! {next} is waiting.',
      'That’s all for this one. Onward to {next}.',
      'Strong work. {next} next.',
      'Sets complete. Time for {next}.',
      'Nailed it. On to {next}.',
      'Exercise finished. Next stop: {next}.',
    ],
    strict: [
      'Done. Straight on to {next}.',
      'Exercise finished. {next}, now.',
      'That’s one. Move to {next}, no wandering.',
      'All sets in. {next} next. Stay focused.',
      'Finished. Get set up for {next}.',
      'Next: {next}. Keep the pace up.',
      'Done here. {next}, let’s go.',
      'One down. {next} won’t do itself.',
      'Complete. On to {next}, eyes forward.',
      'That’s it for this one. {next}, now.',
      'Good. Next exercise: {next}. Move.',
      'Sets done. {next} next, same intensity.',
      'Finished. Don’t lose momentum, {next}.',
      'Exercise done. {next}. Keep working.',
      'Wrapped. Head to {next}, no phone breaks.',
    ],
  },
  last_set_workout: {
    supportive: [
      'Last one done, finish strong! You did it.',
      'That’s the final set. So proud of you!',
      'Last set done. Lovely workout today.',
      'All done! Be proud of showing up.',
      'Final set complete. You took care of yourself today.',
      'That’s everything. Well done, really.',
      'Workout complete! Time to rest and recover.',
      'Last set in. That was a great session.',
      'All sets done. Thank you for showing up for yourself.',
      'Finished! Tap Finish when you’re ready.',
      'The last one, done. Wonderful effort.',
      'Every set done today. Lovely!',
      'Last set done, finish strong! Enjoy the rest.',
      'That’s the workout. You should feel good.',
      'All complete. A kind, solid session.',
    ],
    balanced: [
      'Last one done, finish strong!',
      'Final set complete. Great workout!',
      'That’s the workout! Tap Finish to save it.',
      'All sets done. Excellent session.',
      'Last set in. You crushed it today.',
      'Workout complete! Well earned.',
      'That’s a wrap on today. Nice work!',
      'Final set done. Another session in the bank.',
      'Every set done. Strong finish!',
      'Last one in. Great job today.',
      'All done! Consistency like this wins.',
      'Workout finished. Proud of that effort.',
      'Last set done, finish strong! Hit Finish.',
      'That’s everything. Solid session!',
      'Final set in the books. Nice!',
    ],
    strict: [
      'Last one done, finish strong!',
      'Final set. Done. That’s how it’s done.',
      'Workout complete. Same again next time.',
      'All sets in. Earned, not given.',
      'Last set done. Log it and recover properly.',
      'That’s the work. Hit Finish.',
      'Final set complete. No shortcuts today. Good.',
      'Done. Every set. That’s the standard.',
      'Last one in. Discipline over motivation.',
      'Workout finished. Now recover, then repeat.',
      'All sets done. That’s showing up.',
      'Last set done. You kept your word.',
      'Final set. Complete. Next session, same focus.',
      'That’s everything. Solid. Don’t skip the next one.',
      'Done. Another one in the bank.',
    ],
  },
  below_target: {
    supportive: [
      'Every rep counts. You’re doing great.',
      'A few short, that’s okay. Listen to your body.',
      'Good effort. Some days are heavier than others.',
      'That’s fine. Progress isn’t a straight line.',
      'You showed up and did the work. That matters.',
      'Short of the target, no worries. Take a full rest.',
      'Totally okay. Maybe a little lighter next set?',
      'Good work. The reps will come back.',
      'Not every set hits the number. You’re still building.',
      'Nice try. Rest well before the next one.',
      'Still a solid set. Be gentle with yourself.',
      'It happens. Breathe, rest, go again.',
      'Effort counts more than numbers today.',
      'You’re still moving forward. Well done.',
      'A bit under, and that’s alright.',
    ],
    balanced: [
      'A bit under target. Full rest, then go again.',
      'Close! Rest up and chase those reps.',
      'Short of the target. Next set, you’ve got this.',
      'Not quite there. Take your full rest.',
      'Tough set. Reset and attack the next one.',
      'Under target, no problem. Focus on form.',
      'Almost! Next set, aim for the bottom of the range.',
      'Shy of the target. Maybe drop the weight a touch.',
      'Good fight. Rest well and go again.',
      'Short today. Still progress. Keep pushing.',
      'Few reps short. Breathe and reset.',
      'That one bit back. You’ll get the next.',
      'Below target. Rest a bit longer this time.',
      'Not your best set. Next one will be better.',
      'Close call. Stay tight on the next one.',
    ],
    strict: [
      'Short of the target. Full rest, then hit it.',
      'Not good enough yet. Next set, every rep.',
      'Under target. Focus. Make the next set count.',
      'Missed the number. Reset and earn it back.',
      'Reps below target. Tighten up, go again.',
      'That’s short. The next set has no excuses.',
      'Below the range. Rest, breathe, deliver.',
      'Not there yet. Next set, own the target.',
      'Short. Shake it off and get it done.',
      'Missed reps. Stay locked in, next set.',
      'Under target. You know you have more.',
      'Short set. Make the next one right.',
      'Below target. Lower the weight if needed, but hit reps.',
      'That fell short. No coasting on the next.',
      'Target missed. Fix it next set.',
    ],
  },
  general: {
    supportive: [
      'Nice set. You’re doing great.',
      'Lovely work, keep it gentle and steady.',
      'Another one done. Well done!',
      'Good set. Breathe and enjoy the rest.',
      'You’re doing really well today.',
      'Set logged. Nice and steady.',
      'That looked good. Keep it up.',
      'Well done. One set at a time.',
      'Good work. Take your time.',
      'Another set in. Proud of you.',
      'Nicely done. Listen to your body.',
      'Steady progress. Lovely.',
      'Good one! Rest up.',
      'That’s the way. Easy does it.',
      'Set done. You’ve got this.',
      'Great effort. Keep going at your pace.',
    ],
    balanced: [
      'Nice set! Keep it rolling.',
      'Solid work. Rest up.',
      'Set done. Looking strong.',
      'That’s the way. Next one.',
      'Good set! Stay focused.',
      'Another one in the bank.',
      'Strong set. Keep going.',
      'Nailed it. Rest and repeat.',
      'Great work, keep the momentum.',
      'Clean set. Nice!',
      'Logged! You’re on a roll.',
      'Good stuff. Keep building.',
      'That’s progress. Keep at it.',
      'Set complete. Stay with it.',
      'Looking good out there!',
      'Well done. On to the next.',
    ],
    strict: [
      'Set done. Next.',
      'Good. Stay focused.',
      'Logged. Keep the intensity.',
      'One more down. Keep working.',
      'Solid. No slacking on the next.',
      'That’s work. Keep going.',
      'Set in. Rest, then attack.',
      'Good. Don’t lose focus now.',
      'Done. Every rep matters.',
      'Keep that standard.',
      'Logged. Stay locked in.',
      'Strong. Now do it again.',
      'Set complete. No shortcuts.',
      'That’s the work. Keep moving.',
      'Good set. Earn the next one.',
      'Keep pushing. You’re not done.',
    ],
  },
  discomfort: {
    supportive: [
      'Take it easy, swap it if it still hurts.',
      'Go gently. Stop if anything feels wrong.',
      'Listen to your body. Lighter is completely fine.',
      'Easy does it. Swap the exercise if it still hurts.',
      'Be kind to that area. Lighter or skip is okay.',
      'No pushing through pain today. Take it easy.',
      'Gentle reps only. Swap it if it bothers you.',
      'Your comfort comes first. Lighten it if needed.',
      'Take care. If it hurts, choose an alternative.',
      'Ease off if it hurts. That’s smart training.',
      'Careful with this one. Stop if it hurts.',
      'Easy on it. A swap is always an option.',
      'Pain isn’t progress. Go lighter or swap.',
      'Look after yourself. Skip it if needed.',
      'Take it slow. If it persists, check with a physio.',
    ],
    balanced: [
      'Take it easy, swap it if it still hurts.',
      'Go lighter here. Swap it if it hurts.',
      'Careful with this one. Pain means stop.',
      'Easy on it. An alternative is fine.',
      'No pushing through pain. Lighten or swap.',
      'Listen to your body on this one.',
      'Take care. Swap it if it’s still uncomfortable.',
      'Ease off if needed. Smart beats tough.',
      'Gentle reps here. Stop if it hurts.',
      'Comfort first. Choose a swap if needed.',
      'Easy. If it still hurts, skip it today.',
      'Go easy on that. Pain isn’t the goal.',
      'Lighter is fine here. Stay pain-free.',
      'Look after it. Swap it if it hurts.',
      'Take it easy. If it persists, see a physio.',
    ],
    strict: [
      'Take it easy, swap it if it still hurts.',
      'Pain is a stop sign. Go lighter or swap.',
      'Don’t push through pain. Swap it.',
      'Easy on this one. Smart training wins.',
      'If it hurts, stop. That’s the rule.',
      'Back off the load here. Pain means stop.',
      'Swap it if it still hurts. No ego.',
      'Careful. Pain isn’t toughness.',
      'Lighten it or swap it. Protect the joint.',
      'Go easy here. Train around it, not through it.',
      'Hurts? Then stop and swap.',
      'Take care with this one. Pain means change it.',
      'Ease off. Long-term progress needs healthy joints.',
      'No grinding through pain. Swap it.',
      'Take it easy. If it persists, see a physio.',
    ],
  },
  rest_over: {
    supportive: [
      'Rest’s up, {set}. Whenever you’re ready!',
      'Rest’s up, {set}. You’ve got this.',
      'Rest’s up, {set}. Nice and steady.',
      'Rest’s up, {set}. Take a breath and go.',
      'Rest’s up, {set}. Gently does it.',
      'Rest’s up, {set}. Ready when you are.',
      'Rest’s up, {set}. You’re doing great.',
      'Rest’s up, {set}. One more good one.',
      'Rest’s up, {set}. Easy and controlled.',
      'Rest’s up, {set}. At your own pace.',
      'Rest’s up, {set}. Lovely work so far.',
      'Rest’s up, {set}. Let’s give it a go.',
      'Rest’s up, {set}. Breathe and begin.',
      'Rest’s up, {set}. Calm and steady.',
      'Rest’s up, {set}. Here we go!',
    ],
    balanced: [
      'Rest’s up, {set}. Let’s go!',
      'Rest’s up, {set}. You’ve got this!',
      'Rest’s up, {set}. Time to work.',
      'Rest’s up, {set}. Make it count!',
      'Rest’s up, {set}. Back at it!',
      'Rest’s up, {set}. Strong and steady.',
      'Rest’s up, {set}. Go get it!',
      'Rest’s up, {set}. Let’s keep rolling.',
      'Rest’s up, {set}. Here we go!',
      'Rest’s up, {set}. Focus and lift.',
      'Rest’s up, {set}. Nice and clean.',
      'Rest’s up, {set}. You’re on a roll!',
      'Rest’s up, {set}. Let’s do this.',
      'Rest’s up, {set}. Keep the momentum.',
      'Rest’s up, {set}. Big set coming!',
    ],
    strict: [
      'Rest’s up, {set}. Go. Now.',
      'Rest’s up, {set}. No delays.',
      'Rest’s up, {set}. Get under it.',
      'Rest’s up, {set}. Earn it.',
      'Rest’s up, {set}. Phone down, lift.',
      'Rest’s up, {set}. Every rep.',
      'Rest’s up, {set}. Stay sharp.',
      'Rest’s up, {set}. Let’s work.',
      'Rest’s up, {set}. No excuses.',
      'Rest’s up, {set}. Full focus.',
      'Rest’s up, {set}. Back to work.',
      'Rest’s up, {set}. Make it count.',
      'Rest’s up, {set}. Attack it.',
      'Rest’s up, {set}. Move.',
      'Rest’s up, {set}. Go get it done.',
    ],
  },
  rest_over_discomfort: {
    supportive: [
      'Rest’s up, {set}. Go gently, swap it if it hurts.',
      'Rest’s up, {set}. Easy does it today.',
      'Rest’s up, {set}. Lighter is completely fine.',
      'Rest’s up, {set}. Stop if anything hurts.',
      'Rest’s up, {set}. Listen to your body.',
      'Rest’s up, {set}. Gentle reps only.',
      'Rest’s up, {set}. Comfort comes first.',
      'Rest’s up, {set}. Take it slowly.',
      'Rest’s up, {set}. Skip it if it still hurts.',
      'Rest’s up, {set}. Be kind to that area.',
      'Rest’s up, {set}. A swap is always fine.',
      'Rest’s up, {set}. Ease in carefully.',
      'Rest’s up, {set}. No pushing through pain.',
      'Rest’s up, {set}. Careful and controlled.',
      'Rest’s up, {set}. Look after yourself.',
    ],
    balanced: [
      'Rest’s up, {set}. Take it easy, swap it if it hurts.',
      'Rest’s up, {set}. Go lighter if needed.',
      'Rest’s up, {set}. Pain means stop.',
      'Rest’s up, {set}. Careful with this one.',
      'Rest’s up, {set}. Easy and pain-free.',
      'Rest’s up, {set}. Listen to your body.',
      'Rest’s up, {set}. Swap it if it bothers you.',
      'Rest’s up, {set}. Smart beats tough here.',
      'Rest’s up, {set}. Gentle reps.',
      'Rest’s up, {set}. Comfort first.',
      'Rest’s up, {set}. Lighter is fine.',
      'Rest’s up, {set}. Stop if it hurts.',
      'Rest’s up, {set}. Go easy on it.',
      'Rest’s up, {set}. A swap is fine too.',
      'Rest’s up, {set}. Stay pain-free.',
    ],
    strict: [
      'Rest’s up, {set}. Light and pain-free, or swap.',
      'Rest’s up, {set}. Pain is a stop sign.',
      'Rest’s up, {set}. No ego, go lighter.',
      'Rest’s up, {set}. Hurts? Swap it.',
      'Rest’s up, {set}. Train around it, not through it.',
      'Rest’s up, {set}. Protect the joint.',
      'Rest’s up, {set}. Careful, pain means stop.',
      'Rest’s up, {set}. Smart training wins.',
      'Rest’s up, {set}. Ease off the load.',
      'Rest’s up, {set}. No grinding through pain.',
      'Rest’s up, {set}. Back off if it hurts.',
      'Rest’s up, {set}. Healthy joints first.',
      'Rest’s up, {set}. Light, or swap it.',
      'Rest’s up, {set}. Stop if it hurts.',
      'Rest’s up, {set}. Lighter is the call.',
    ],
  },
};

/** Pick a line for a situation/style, filling {placeholders}, never the same line as `last`. */
export function pickLine(situation: CheerSituation, style: CoachStyle, vars: Record<string, string>, last?: string | null, rand: () => number = Math.random): string {
  const fill = (t: string) => t.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
  const options = CHEER_LINES[situation][style].map(fill);
  const pool = options.filter((l) => l !== last);
  const list = pool.length ? pool : options;
  return list[Math.min(list.length - 1, Math.floor(rand() * list.length))];
}

const isWarmup = (s: LoggedSet) => s.type === 'warmup';

/** A new record set by exactly this set, compared with history and the earlier sets of this workout (existing stats rules). */
export function recordForSet(session: WorkoutSession, seId: ID, setId: ID, history: WorkoutSession[], byId: Map<ID, Exercise>, unit: WeightUnit): string | null {
  const se = session.exercises.find((e) => e.id === seId);
  const set = se?.sets.find((x) => x.id === setId);
  if (!se || !set || isWarmup(set)) return null;
  const only: WorkoutSession = { ...session, id: `${session.id}#cheer`, status: 'completed', exercises: [{ ...se, sets: [set] }] };
  const before: WorkoutSession = {
    ...session,
    status: 'completed',
    exercises: session.exercises.map((e) => ({ ...e, sets: e.sets.filter((x) => x.completed && x.id !== setId) })),
  };
  const hit = detectRecords(only, [...history.filter((h) => h.id !== session.id), before], byId, unit).find((r) => r.exerciseId === se.exerciseId);
  if (!hit) return null;
  // "Bench press: heaviest set 60 kg × 8" → "60 kg × 8"; keep other labels' detail after the colon.
  const detail = hit.label.split(': ').slice(1).join(': ');
  return detail.replace(/^heaviest set /, '').replace(/^best estimated 1RM /, 'est. 1RM ') || hit.label;
}

export interface SetCheerInput {
  /** The session AFTER the set was ticked done. */
  session: WorkoutSession;
  seId: ID;
  setId: ID;
  style?: CoachStyle;
  history: WorkoutSession[];
  byId: Map<ID, Exercise>;
  unit: WeightUnit;
  last?: string | null;
  rand?: () => number;
}

export interface Cheer {
  situation: CheerSituation;
  line: string;
}

/** The cheer for a set that was just ticked done, or null (warm-up, set not done, unknown set). */
export function cheerForSet(i: SetCheerInput): Cheer | null {
  const style = i.style ?? 'balanced';
  const idx = i.session.exercises.findIndex((e) => e.id === i.seId);
  const se = i.session.exercises[idx];
  const set = se?.sets.find((x) => x.id === i.setId);
  if (!se || !set || !set.completed || isWarmup(set)) return null;
  const say = (situation: CheerSituation, vars: Record<string, string> = {}): Cheer => ({ situation, line: pickLine(situation, style, vars, i.last, i.rand) });

  if (se.discomfort) return say('discomfort');
  const record = recordForSet(i.session, i.seId, i.setId, i.history, i.byId, i.unit);
  if (record) return say('pr', { record });

  const working = (e: SessionExercise) => e.sets.filter((x) => !isWarmup(x));
  const allDone = i.session.exercises.every((e) => working(e).every((x) => x.completed));
  if (allDone) return say('last_set_workout');

  const rx = se.prescription;
  const repBased = !!rx && !rx.durationSec && set.reps != null;
  if (repBased && rx!.repMax > 0 && set.reps! >= rx!.repMax) return say('top_of_range');
  if (repBased && rx!.repMin > 0 && set.reps! < rx!.repMin) return say('below_target');

  if (working(se).every((x) => x.completed)) {
    const next = i.session.exercises.slice(idx + 1).concat(i.session.exercises.slice(0, idx)).find((e) => working(e).some((x) => !x.completed));
    const name = next ? i.byId.get(next.exerciseId)?.name : undefined;
    if (name) return say('last_set_exercise', { next: name });
  }
  return say('general');
}

export interface NextSet {
  seId: ID;
  exerciseName: string;
  /** 1-based number among the exercise's working sets. */
  number: number;
  label: string;
  /** "60 kg × 8" / "8 reps" / "30 s", or '' when nothing is known yet. */
  detail: string;
  discomfort: boolean;
}

/** The next set to do: the rested-for exercise first if it still has sets left, then in workout order. */
export function nextSet(session: WorkoutSession, byId: Map<ID, Exercise>, unit: WeightUnit, preferSeId?: ID): NextSet | null {
  const order = [...session.exercises];
  const pref = preferSeId ? order.findIndex((e) => e.id === preferSeId) : -1;
  const candidates = pref >= 0 ? [order[pref], ...order.slice(pref + 1), ...order.slice(0, pref)] : order;
  for (const se of candidates) {
    const working = se.sets.filter((x) => !isWarmup(x));
    const n = working.findIndex((x) => !x.completed);
    if (n < 0) continue;
    const s = working[n];
    const name = byId.get(se.exerciseId)?.name ?? 'Next exercise';
    const rx = se.prescription;
    const load = s.weightKg != null && s.weightKg > 0 ? formatWeight(s.weightKg, unit, s.entered) : null;
    const reps = s.reps ?? (rx && !rx.durationSec ? rx.repMin === rx.repMax ? rx.repMin : null : null);
    const dur = s.durationSec ?? rx?.durationSec ?? null;
    const what = load && reps ? `${load} × ${reps}` : load ? load : reps ? `${reps} reps` : dur ? `${dur} s` : '';
    return { seId: se.id, exerciseName: name, number: n + 1, label: `${name} set ${n + 1}${what ? `: ${what}` : ''}`, detail: what, discomfort: !!se.discomfort };
  }
  return null;
}

/** "Rest's up, Bench press set 3: 60 kg × 8. Let's go!" — or null when every set is done. */
export function restOverCheer(session: WorkoutSession, byId: Map<ID, Exercise>, unit: WeightUnit, style: CoachStyle = 'balanced', last?: string | null, rand?: () => number): Cheer | null {
  const n = nextSet(session, byId, unit, session.rest?.forExerciseId);
  if (!n) return null;
  const situation: CheerSituation = n.discomfort ? 'rest_over_discomfort' : 'rest_over';
  return { situation, line: pickLine(situation, style, { set: n.label }, last, rand) };
}
