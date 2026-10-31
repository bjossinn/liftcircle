/**
 * Pure helpers about coaching relationships: who can write, human-readable states, sharing scopes.
 * Used by the coach/client screens and the coach-message outbox (which re-checks writability
 * before sending anything that was queued offline).
 */
import type { CoachingRelationship, RelationshipStatus, SharingScopes } from '@/backend/coachingContract';

export type Writable = { ok: true } | { ok: false; reason: string };

/** Mirrors the server's `is_relationship_participant(…, writable => true)` as far as the client can see it. */
export function relationshipWritable(rel: Pick<CoachingRelationship, 'status' | 'coach' | 'viewerIsCoach'> | null | undefined): Writable {
  if (!rel) return { ok: false, reason: 'This conversation is no longer available to you.' };
  switch (rel.status) {
    case 'requested':
      return { ok: false, reason: rel.viewerIsCoach ? 'Accept the request to start chatting.' : 'Chat starts once the coach accepts your request.' };
    case 'declined':
      return { ok: false, reason: 'This request was declined, so no new messages can be sent.' };
    case 'cancelled':
      return { ok: false, reason: 'This request was cancelled, so no new messages can be sent.' };
    case 'ended':
      return { ok: false, reason: 'Coaching has ended, so no new messages can be sent.' };
  }
  if (rel.coach.suspended)
    return {
      ok: false,
      reason: rel.viewerIsCoach ? 'Your coach account is suspended, so messaging is paused.' : 'Your coach’s account is currently suspended, so messaging is paused.',
    };
  if (!rel.coach.approved) return { ok: false, reason: 'This coach is no longer approved on Hard Earned, so messaging is paused.' };
  return { ok: true };
}

export const RELATIONSHIP_STATUS_LABEL: Record<RelationshipStatus, string> = {
  requested: 'Requested',
  active: 'Active',
  declined: 'Declined',
  cancelled: 'Cancelled',
  ended: 'Ended',
};

/** Retention wording shown on read-only conversations (matches the server's readable rule). */
export const RETENTION_TEXT =
  'Ended conversations stay readable for both of you, but no new messages can be sent. If a coach’s account is suspended, the coach loses access to the conversation; the client keeps it.';

export const SCOPE_KEYS: (keyof SharingScopes)[] = ['training', 'measurements', 'nutrition', 'checkins'];

export const SCOPE_INFO: Record<keyof SharingScopes, { label: string; reveals: string; needs: string }> = {
  training: {
    label: 'Training',
    reveals: 'Your workouts (exercises, sets, loads, notes), how many planned sessions you completed, your active program and goals.',
    needs: 'Needed for your coach to build or adjust your program and give feedback on your sessions.',
  },
  measurements: {
    label: 'Measurements',
    reveals: 'Bodyweight and body measurements you have logged.',
    needs: 'Useful when your goal involves body composition or weight change.',
  },
  nutrition: {
    label: 'Nutrition',
    reveals: 'Your food log totals (protein and calories per day).',
    needs: 'Only needed if your coach helps you with nutrition.',
  },
  checkins: {
    label: 'Check-ins',
    reveals: 'Check-ins you submit: energy, sleep, soreness, stress, bodyweight if you add it, and your notes.',
    needs: 'Needed for your coach to review and respond to your check-ins.',
  },
};

export const NO_SCOPES: SharingScopes = { training: false, measurements: false, nutrition: false, checkins: false };

export function sameScopes(a: SharingScopes, b: SharingScopes): boolean {
  return SCOPE_KEYS.every((k) => !!a[k] === !!b[k]);
}

/** Order a client's relationships: active first, then open requests, then the most recent closed. */
export function sortClientRelationships(rels: CoachingRelationship[]): CoachingRelationship[] {
  const rank: Record<RelationshipStatus, number> = { active: 0, requested: 1, ended: 2, declined: 2, cancelled: 2 };
  const t = (r: CoachingRelationship) => Date.parse(r.endedAt ?? r.respondedAt ?? r.requestedAt) || 0;
  return [...rels].sort((a, b) => rank[a.status] - rank[b.status] || t(b) - t(a));
}

/** Explanation for a closed relationship, from the client's point of view. */
export function closedExplanation(rel: CoachingRelationship): string {
  const name = rel.coach.displayName || 'The coach';
  switch (rel.status) {
    case 'declined':
      return `${name} declined your request${rel.endReason ? `: “${rel.endReason}”` : '.'} You can look for another coach any time.`;
    case 'cancelled':
      return 'You cancelled this request before it was answered.';
    case 'ended':
      return `${rel.endedBy && rel.endedBy === rel.coachId ? `${name} ended coaching` : 'Coaching ended'}${rel.endReason ? `: “${rel.endReason}”` : '.'} Your workouts and accepted programs stay yours, and the conversation stays readable.`;
    default:
      return '';
  }
}
