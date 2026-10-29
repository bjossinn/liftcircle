import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_TYPES, activityLabel, epochToZonedTime, estimateEnergyKcal, hasField, hmsToSec, paceOrSpeed, splitHms, validateActivity, zonedTimeToEpoch,
} from '@/domain/activities';
import { expandIntervals, intervalsFromRounds, roundsFromIntervals, advanceTimer, startTimer, pauseTimer, resumeTimer, skipPhase, type TimerState } from '@/features/activities/intervals';

describe('activity types', () => {
  it('covers every required type with relevant fields', () => {
    expect(ACTIVITY_TYPES.map((t) => t.type)).toEqual(['walk', 'run', 'cycle', 'hike', 'swim', 'row', 'sport', 'class', 'yoga', 'mobility', 'stretch', 'custom']);
    for (const t of ['walk', 'run', 'cycle', 'hike', 'swim', 'row'] as const) expect(hasField(t, 'distance')).toBe(true);
    for (const t of ['run', 'cycle', 'hike', 'walk'] as const) expect(hasField(t, 'elevation')).toBe(true);
    expect(hasField('yoga', 'distance')).toBe(false);
    expect(hasField('cycle', 'pace')).toBe(false); // cycling shows speed instead
  });
  it('labels activities', () => {
    expect(activityLabel({ type: 'run' })).toBe('Run');
    expect(activityLabel({ type: 'custom', customName: 'Climbing' })).toBe('Climbing');
    expect(activityLabel({ type: 'custom' })).toBe('Custom activity');
  });
});

describe('pace & speed', () => {
  it('5 km in 25:00 → 5:00 /km', () => {
    expect(paceOrSpeed({ type: 'run', distanceM: 5000, durationSec: 1500 }, 'km')!.text).toBe('5:00 /km');
  });
  it('10 km in 50 min → 8:03 /mi', () => {
    expect(paceOrSpeed({ type: 'run', distanceM: 10000, durationSec: 3000 }, 'mi')!.text).toBe('8:03 /mi');
  });
  it('cycling shows speed in km/h or mph', () => {
    const r = paceOrSpeed({ type: 'cycle', distanceM: 30000, durationSec: 3600 }, 'km')!;
    expect(r.kind).toBe('speed');
    expect(r.text).toBe('30 km/h');
    expect(paceOrSpeed({ type: 'cycle', distanceM: 16093.44, durationSec: 3600 }, 'mi')!.text).toBe('10 mph');
  });
  it('swim per 100 m and row per 500 m', () => {
    expect(paceOrSpeed({ type: 'swim', distanceM: 1500, durationSec: 1800 }, 'km')!.text).toBe('2:00 /100 m');
    expect(paceOrSpeed({ type: 'row', distanceM: 2000, durationSec: 480 }, 'mi')!.text).toBe('2:00 /500 m');
  });
  it('returns null without distance or for non-distance types', () => {
    expect(paceOrSpeed({ type: 'run', durationSec: 1500 }, 'km')).toBeNull();
    expect(paceOrSpeed({ type: 'yoga', distanceM: 1000, durationSec: 1500 }, 'km')).toBeNull();
  });
  it('splits and joins h:m:s', () => {
    expect(splitHms(3725)).toEqual({ h: 1, m: 2, s: 5 });
    expect(hmsToSec(1, 2, 5)).toBe(3725);
    expect(hmsToSec(null, 30, null)).toBe(1800);
  });
});

describe('validation', () => {
  const ok = { type: 'run' as const, date: '2026-01-05', durationSec: 1500, distanceM: 5000 };
  it('accepts a normal run', () => expect(validateActivity(ok).ok).toBe(true));
  it('requires 1 min – 24 h', () => {
    const r1 = validateActivity({ ...ok, durationSec: 30 });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.errors.durationSec).toMatch(/1 minute/);
    const r2 = validateActivity({ ...ok, durationSec: 25 * 3600 });
    if (!r2.ok) expect(r2.errors.durationSec).toMatch(/24 hours/);
    else throw new Error('expected failure');
  });
  it('rejects implausible distances and speeds per type', () => {
    expect(validateActivity({ ...ok, distanceM: 500_000 }).ok).toBe(false);
    const fast = validateActivity({ ...ok, distanceM: 20000, durationSec: 1800 }); // 40 km/h run
    expect(fast.ok).toBe(false);
    expect(validateActivity({ ...ok, type: 'cycle', distanceM: 20000, durationSec: 1800 }).ok).toBe(true);
    expect(validateActivity({ ...ok, distanceM: 0 }).ok).toBe(false);
  });
  it('checks heart rate bounds and avg ≤ max', () => {
    expect(validateActivity({ ...ok, avgHr: 25 }).ok).toBe(false);
    expect(validateActivity({ ...ok, maxHr: 240 }).ok).toBe(false);
    const r = validateActivity({ ...ok, avgHr: 170, maxHr: 160 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.avgHr).toMatch(/higher than maximum/);
    expect(validateActivity({ ...ok, avgHr: 150, maxHr: 175 }).ok).toBe(true);
  });
  it('requires a name for custom activities', () => {
    expect(validateActivity({ type: 'custom', date: '2026-01-05', durationSec: 600 }).ok).toBe(false);
    expect(validateActivity({ type: 'custom', customName: 'Climbing', date: '2026-01-05', durationSec: 600 }).ok).toBe(true);
  });
});

describe('approximate energy', () => {
  it('uses MET × kg × hours only when bodyweight is known', () => {
    expect(estimateEnergyKcal({ type: 'run', intensity: 'moderate', durationSec: 3600, weightKg: 80 })).toEqual({ kcal: 760, met: 9.5 });
    expect(estimateEnergyKcal({ type: 'run', durationSec: 3600 })).toBeNull();
  });
});

describe('local time', () => {
  it('round-trips wall-clock time in a time zone', () => {
    const e = zonedTimeToEpoch('2026-07-01', '07:30', 'America/New_York');
    expect(e).toBe(Date.UTC(2026, 6, 1, 11, 30));
    expect(epochToZonedTime(e, 'America/New_York')).toBe('07:30');
    expect(zonedTimeToEpoch('2026-01-15', '18:00', 'Atlantic/Reykjavik')).toBe(Date.UTC(2026, 0, 15, 18, 0));
  });
});

describe('interval timer', () => {
  const plan = intervalsFromRounds({ warmupSec: 60, steps: [{ label: 'Work', seconds: 30 }, { label: 'Rest', seconds: 15 }], rounds: 3, cooldownSec: 0 });
  it('expands rounds as a circuit', () => {
    const phases = expandIntervals(plan);
    expect(phases.map((p) => p.label)).toEqual(['Warm-up', 'Work', 'Rest', 'Work', 'Rest', 'Work', 'Rest']);
    expect(phases.reduce((s, p) => s + p.seconds, 0)).toBe(60 + 3 * 45);
    expect(roundsFromIntervals(plan)).toEqual({ warmupSec: 60, steps: [{ label: 'Work', seconds: 30 }, { label: 'Rest', seconds: 15 }], rounds: 3, cooldownSec: 0 });
  });
  it('recomputes from deadlines after backgrounding, and pauses/resumes/skips', () => {
    const phases = expandIntervals(plan);
    let t: TimerState = startTimer(phases, 0);
    expect(t.index).toBe(0);
    // App backgrounded for 100 s: warm-up (60) + work (30) done, 10 s into rest.
    let r = advanceTimer(t, 100_000);
    t = r.state;
    expect(r.changed).toBe(true);
    expect(t.index).toBe(2);
    expect(t.phaseEndsAt! - 100_000).toBe(5_000);
    t = pauseTimer(t, 101_000);
    expect(t.pausedRemainingMs).toBe(4_000);
    r = advanceTimer(t, 500_000);
    expect(r.state.index).toBe(2); // paused: nothing moves
    t = resumeTimer(t, 500_000);
    expect(t.phaseEndsAt).toBe(504_000);
    t = skipPhase(t, 501_000);
    expect(t.index).toBe(3);
    expect(t.phaseEndsAt).toBe(531_000);
    r = advanceTimer(t, 10_000_000);
    expect(r.state.status).toBe('done');
  });
});
