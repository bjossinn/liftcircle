/**
 * Sync barrier for the training assistant (1.0.3). The coach reads the user's records from the server, so a workout or
 * food log that is still only on this device (in the outbox) would be invisible to it — and it could act on stale data
 * ("you haven't trained this week" right after an offline workout). Before a message is sent:
 *  - nothing pending → send straight away;
 *  - otherwise run a sync and wait for it, but never longer than `timeoutMs` (the user is waiting);
 *  - return how many changes are STILL unsynced, so the server can tell the coach its view may be missing them.
 */
import { syncNow } from '@/sync/engine';
import type { LiftDb } from '@/db/db';

export const AI_SYNC_TIMEOUT_MS = 4000;

export async function syncBeforeAi(
  db: Pick<LiftDb, 'outbox' | 'isGuest'>,
  opts: { timeoutMs?: number; sync?: () => Promise<void> } = {},
): Promise<number> {
  const pending = async () => {
    try {
      return await db.outbox.count();
    } catch {
      return 0;
    }
  };
  if (db.isGuest || (await pending()) === 0) return 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    (opts.sync ?? syncNow)().catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, opts.timeoutMs ?? AI_SYNC_TIMEOUT_MS);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return pending();
}
