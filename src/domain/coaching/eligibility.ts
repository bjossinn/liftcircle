/** Whether the viewer can send a coaching request to a coach, with the reason when not. Pure; the server re-checks. */
import type { CoachingRelationship } from '@/backend/coachingContract';

export const MAX_OPEN_REQUESTS = 3;

export type RequestBlock = 'self' | 'not_accepting' | 'already_coach' | 'pending' | 'too_many_pending';

export function requestBlock(input: {
  coachId: string;
  acceptingClients: boolean;
  meId: string | undefined;
  relationships: CoachingRelationship[] | null | undefined;
}): RequestBlock | null {
  if (input.meId && input.meId === input.coachId) return 'self';
  const mine = (input.relationships ?? []).filter((r) => !r.viewerIsCoach);
  if (mine.some((r) => r.coachId === input.coachId && r.status === 'active')) return 'already_coach';
  if (mine.some((r) => r.coachId === input.coachId && r.status === 'requested')) return 'pending';
  if (!input.acceptingClients) return 'not_accepting';
  if (mine.filter((r) => r.status === 'requested').length >= MAX_OPEN_REQUESTS) return 'too_many_pending';
  return null;
}

export const REQUEST_BLOCK_TEXT: Record<RequestBlock, string> = {
  self: 'This is your own coach profile.',
  not_accepting: 'This coach isn’t taking new clients right now.',
  already_coach: 'This is already your coach.',
  pending: 'You’ve already sent this coach a request. You’ll be notified when they reply.',
  too_many_pending: `You have ${MAX_OPEN_REQUESTS} requests waiting for a reply. Cancel one in My coach to send another.`,
};

/** The client's current active human coach, if any (for the switching explanation). */
export function activeCoach(relationships: CoachingRelationship[] | null | undefined): CoachingRelationship | null {
  return (relationships ?? []).find((r) => !r.viewerIsCoach && r.status === 'active') ?? null;
}
