/**
 * Pure helpers about coaching relationships: who can write, human-readable states, sharing scopes.
 * Used by the coach/client screens and the coach-message outbox (which re-checks writability
 * before sending anything that was queued offline).
 */
import type { CoachingRelationship, RelationshipStatus, SharingScopes } from '@/backend/coachingContract';
import { t, type MessageKey } from '@/i18n';

export type Writable = { ok: true } | { ok: false; reason: string };

/** Mirrors the server's `is_relationship_participant(…, writable => true)` as far as the client can see it. */
export function relationshipWritable(rel: Pick<CoachingRelationship, 'status' | 'coach' | 'viewerIsCoach'> | null | undefined): Writable {
  if (!rel) return { ok: false, reason: t('coaching.relationship.no_longer_available') };
  switch (rel.status) {
    case 'requested':
      return { ok: false, reason: rel.viewerIsCoach ? t('coaching.relationship.accept_to_start_chatting') : t('coaching.relationship.chat_starts_once_accepted') };
    case 'declined':
      return { ok: false, reason: t('coaching.relationship.declined_no_messages') };
    case 'cancelled':
      return { ok: false, reason: t('coaching.relationship.cancelled_no_messages') };
    case 'ended':
      return { ok: false, reason: t('coaching.relationship.ended_no_messages') };
  }
  if (rel.coach.suspended)
    return {
      ok: false,
      reason: rel.viewerIsCoach ? t('coaching.relationship.own_account_suspended') : t('coaching.relationship.coach_suspended'),
    };
  if (!rel.coach.approved) return { ok: false, reason: t('coaching.relationship.coach_not_approved') };
  return { ok: true };
}

/** Status labels in the current language (getters, so each read follows the app language). */
export const RELATIONSHIP_STATUS_LABEL: Readonly<Record<RelationshipStatus, string>> = {
  get requested() {
    return t('coaching.relationship.status.requested');
  },
  get active() {
    return t('coaching.relationship.status.active');
  },
  get declined() {
    return t('coaching.relationship.status.declined');
  },
  get cancelled() {
    return t('coaching.relationship.status.cancelled');
  },
  get ended() {
    return t('coaching.relationship.status.ended');
  },
};

/** Retention wording shown on read-only conversations (matches the server's readable rule). */
export const retentionText = (): string => t('coaching.relationship.retention');

export const SCOPE_KEYS: (keyof SharingScopes)[] = ['training', 'measurements', 'nutrition', 'checkins'];

const SCOPE_LABEL_KEY: Record<keyof SharingScopes, MessageKey> = {
  training: 'ai.scope.training',
  measurements: 'ai.scope.measurements',
  nutrition: 'today.nutrition',
  checkins: 'coaching.shareScope.check_ins',
};

function scopeInfo(k: keyof SharingScopes): { readonly label: string; readonly reveals: string; readonly needs: string } {
  return {
    get label() {
      return t(SCOPE_LABEL_KEY[k]);
    },
    get reveals() {
      return t(`coaching.relationship.scope.${k}.reveals`);
    },
    get needs() {
      return t(`coaching.relationship.scope.${k}.needs`);
    },
  };
}

/** What each sharing scope reveals and why a coach needs it, in the current language. */
export const SCOPE_INFO: Readonly<Record<keyof SharingScopes, { readonly label: string; readonly reveals: string; readonly needs: string }>> = {
  training: scopeInfo('training'),
  measurements: scopeInfo('measurements'),
  nutrition: scopeInfo('nutrition'),
  checkins: scopeInfo('checkins'),
};

export const NO_SCOPES: SharingScopes = { training: false, measurements: false, nutrition: false, checkins: false };

export function sameScopes(a: SharingScopes, b: SharingScopes): boolean {
  return SCOPE_KEYS.every((k) => !!a[k] === !!b[k]);
}

/** Order a client's relationships: active first, then open requests, then the most recent closed. */
export function sortClientRelationships(rels: CoachingRelationship[]): CoachingRelationship[] {
  const rank: Record<RelationshipStatus, number> = { active: 0, requested: 1, ended: 2, declined: 2, cancelled: 2 };
  const at = (r: CoachingRelationship) => Date.parse(r.endedAt ?? r.respondedAt ?? r.requestedAt) || 0;
  return [...rels].sort((a, b) => rank[a.status] - rank[b.status] || at(b) - at(a));
}

/** Explanation for a closed relationship, from the client's point of view. */
export function closedExplanation(rel: CoachingRelationship): string {
  const name = rel.coach.displayName || t('coaching.relationship.the_coach');
  const reason = rel.endReason;
  switch (rel.status) {
    case 'declined':
      return reason ? t('coaching.relationship.declined_with_reason', { name, reason }) : t('coaching.relationship.declined_no_reason', { name });
    case 'cancelled':
      return t('coaching.relationship.cancelled_explanation');
    case 'ended':
      if (rel.endedBy && rel.endedBy === rel.coachId)
        return reason ? t('coaching.relationship.ended_by_coach_with_reason', { name, reason }) : t('coaching.relationship.ended_by_coach_no_reason', { name });
      return reason ? t('coaching.relationship.ended_with_reason', { reason }) : t('coaching.relationship.ended_no_reason');
    default:
      return '';
  }
}
