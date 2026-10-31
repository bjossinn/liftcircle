/**
 * Planned-week streak for the Today screen: how many weeks in a row every planned session was done.
 * - A week counts when it had at least one planned session and none of them ended up missed (skipped and moved
 *   sessions don't count against it).
 * - The current week joins the streak once all of its planned sessions are done; until then the streak runs to last
 *   week, so it never drops mid-week just because a session is still ahead.
 * - Weeks before the program started don't count. Looks back at most a year.
 */
import type { ActivityLog, ISODate, Program, WorkoutSession } from '@/domain/types';
import { addDays, startOfWeek } from '@/lib/dates';
import { plannedSessionsInRange } from './schedule';

const MAX_WEEKS = 52;

function weekComplete(p: Program, from: ISODate, today: ISODate, sessions: WorkoutSession[], activities: ActivityLog[]): boolean | null {
  const items = plannedSessionsInRange(p, from, addDays(from, 6), today, sessions, activities).filter((x) => x.status !== 'skipped' && x.status !== 'moved');
  if (items.length === 0) return null;
  return items.every((x) => x.status === 'done');
}

export function plannedWeekStreak(p: Program | null | undefined, sessions: WorkoutSession[], activities: ActivityLog[], today: ISODate, weekStart: 0 | 1): number {
  if (!p) return 0;
  const thisWeek = startOfWeek(today, weekStart);
  let streak = weekComplete(p, thisWeek, today, sessions, activities) === true ? 1 : 0;
  for (let i = 1; i <= MAX_WEEKS; i++) {
    const from = addDays(thisWeek, -7 * i);
    if (addDays(from, 6) < p.startDate) break;
    if (weekComplete(p, from, today, sessions, activities) !== true) break;
    streak++;
  }
  return streak;
}
