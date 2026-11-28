/** Whether the viewer can send a coaching request to a coach, with the reason when not. Pure; the server re-checks. */
import type { CoachingRelationship } from '@/backend/coachingContract';
import { t, type MessageKey } from '@/i18n';

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

const REQUEST_BLOCK_KEYS: Record<RequestBlock, MessageKey> = {
  self: 'coaching.request.block_self',
  not_accepting: 'coaching.request.block_not_accepting',
  already_coach: 'coaching.request.block_already_coach',
  pending: 'coaching.request.block_pending',
  too_many_pending: 'coaching.request.block_too_many_pending',
};
export const requestBlockText = (b: RequestBlock) => t(REQUEST_BLOCK_KEYS[b], { count: MAX_OPEN_REQUESTS });
/** Why a request can't be sent, read in the current language. */
export const REQUEST_BLOCK_TEXT: Record<RequestBlock, string> = Object.freeze(
  Object.defineProperties(
    {} as Record<RequestBlock, string>,
    Object.fromEntries((Object.keys(REQUEST_BLOCK_KEYS) as RequestBlock[]).map((b) => [b, { enumerable: true, get: () => requestBlockText(b) }])),
  ),
);

/** The client's current active human coach, if any (for the switching explanation). */
export function activeCoach(relationships: CoachingRelationship[] | null | undefined): CoachingRelationship | null {
  return (relationships ?? []).find((r) => !r.viewerIsCoach && r.status === 'active') ?? null;
}
