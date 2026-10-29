/** Guards against drift between copies the server can't import from the app (Deno functions vs src/). */
import { describe, expect, it } from 'vitest';
import { SPLIT_LABELS } from '../../supabase/functions/_shared/ai/context';
import { SPLITS } from '@/domain/program/templates';

describe('server copies stay in sync with the app', () => {
  it('AI context knows every split the generator can produce, with the same labels', () => {
    for (const [key, def] of Object.entries(SPLITS)) {
      expect(SPLIT_LABELS[key], key).toBeTruthy();
      if (key !== 'es') expect(SPLIT_LABELS[key]).toBe(def.label);
    }
  });
});

import { hasCompletedWork } from '@/domain/setValidation';
describe('adherence counts only real work', () => {
  const s = (sets: object[]) => ({ exercises: [{ id: 'x', exerciseId: 'barbell-back-squat', sets }] }) as never;
  it('a finished session whose only done set is 20 kg × 0 reps does not count', () => {
    expect(hasCompletedWork(s([{ id: 'a', completed: true, weightKg: 20, reps: 0 }]))).toBe(false);
    expect(hasCompletedWork(s([{ id: 'a', completed: false, weightKg: 20, reps: 8 }]))).toBe(false);
    expect(hasCompletedWork(s([{ id: 'a', completed: true, weightKg: -5, reps: 8 }]))).toBe(false);
  });
  it('real reps, time or distance count; a session with no sets (activity-style) counts', () => {
    expect(hasCompletedWork(s([{ id: 'a', completed: true, weightKg: 20, reps: 8 }]))).toBe(true);
    expect(hasCompletedWork(s([{ id: 'a', completed: true, durationSec: 30 }]))).toBe(true);
    expect(hasCompletedWork(s([{ id: 'a', completed: true, distanceM: 400 }]))).toBe(true);
    expect(hasCompletedWork({ exercises: [] } as never)).toBe(true);
  });
});
