/**
 * Optional automatic sharing of completed workouts/activities.
 * Only runs when the user explicitly enabled it (settings.social.autoShare.enabled), uses the
 * stated audience and fields, and NEVER attaches photos (photos always need a deliberate choice).
 */
import type { ActivityLog, Exercise, ID, Settings, WorkoutSession } from '@/domain/types';
import type { LiftDb } from '@/db/db';
import { kvGet, kvSet } from '@/db/repo';
import { uuid } from '@/lib/id';
import { buildActivitySnapshot, buildWorkoutSnapshot } from './snapshot';
import { processPendingPosts, queuePost } from './pendingPosts';

const markerKey = (recordId: ID) => `social:autoShared:${recordId}`;

export async function maybeAutoShare(
  source: { session?: WorkoutSession; activity?: ActivityLog },
  ctx: { db: LiftDb; settings: Settings; byId: Map<ID, Exercise> },
): Promise<boolean> {
  try {
    const auto = ctx.settings.social?.autoShare;
    if (!auto?.enabled) return false;
    if (ctx.db.isGuest) return false; // sharing needs an account
    const { session, activity } = source;
    const record = session ?? activity;
    if (!record || record.deletedAt) return false;
    if (session && session.status !== 'completed') return false;
    // Already shared (manually or automatically) → don't post twice.
    if (record.sharedPostIds?.length) return false;
    if (await kvGet<boolean>(markerKey(record.id), ctx.db)) return false;
    const already = await ctx.db.pendingPosts.filter((p) => p.sourceRecordId === record.id).count();
    if (already) return false;

    const snapshot = session
      ? buildWorkoutSnapshot(session, auto.fields, { byId: ctx.byId, unit: ctx.settings.units.weight })
      : buildActivitySnapshot(activity!, auto.fields, { distanceUnit: ctx.settings.units.distance });

    await queuePost(
      {
        id: uuid(),
        kind: session ? 'workout' : 'activity',
        audience: auto.audience,
        caption: '',
        snapshot,
        sourceRecordId: record.id,
        photos: [], // never automatic
      },
      ctx.db,
    );
    await kvSet(markerKey(record.id), true, ctx.db);
    void processPendingPosts(ctx.db);
    return true;
  } catch {
    // Social failures never affect workout saving.
    return false;
  }
}
