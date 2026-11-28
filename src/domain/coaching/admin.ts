/** Admin review rules mirrored on the client (the server re-checks current status on every action). Pure. */
import type { ApplicationStatus, CoachProfile, ReviewAction } from '@/backend/coachingContract';
import { t, type MessageKey } from '@/i18n';

export type QueueTab = ApplicationStatus | 'suspended' | 'qualifications_pending';
const tab = (value: Exclude<QueueTab, 'draft'>, key: MessageKey) =>
  Object.freeze({
    value,
    get label() {
      return t(key);
    },
  });
export const QUEUE_TABS: { value: Exclude<QueueTab, 'draft'>; label: string }[] = [
  tab('submitted', 'coaching.admin.submitted'),
  tab('changes_requested', 'coaching.admin.changes_requested'),
  tab('approved', 'coaching.admin.approved'),
  tab('rejected', 'coaching.admin.rejected'),
  tab('suspended', 'coaching.admin.suspended'),
  tab('qualifications_pending', 'coaching.admin.qualifications_pending'),
];
export const isQueueTab = (s: string | null): s is Exclude<QueueTab, 'draft'> => QUEUE_TABS.some((t) => t.value === s);

export type ProfileAction = Extract<ReviewAction, 'approve' | 'request_changes' | 'reject' | 'suspend' | 'reinstate'>;

/** Which whole-application actions make sense for the current state. */
export function availableActions(p: Pick<CoachProfile, 'status' | 'suspended'>): ProfileAction[] {
  if (p.suspended) return ['reinstate'];
  switch (p.status) {
    case 'submitted':
      return ['approve', 'request_changes', 'reject'];
    case 'changes_requested':
      return ['reject'];
    case 'approved':
      return ['suspend'];
    default:
      return [];
  }
}

export function reasonRequired(a: ReviewAction): boolean {
  return a === 'request_changes' || a === 'reject' || a === 'suspend' || a === 'reject_qualification';
}

export const REASON_MAX = 2000;

export function reasonProblem(a: ReviewAction, reason: string): string | null {
  const text = reason.trim();
  if (reasonRequired(a) && !text) return t(a === 'request_changes' ? 'coaching.admin.tell_the_applicant_what_to_change' : 'coaching.admin.add_a_reason_the_coach_will_see_it');
  if (text.length > REASON_MAX) return t('coaching.validation.at_most_chars', { max: REASON_MAX });
  return null;
}

export interface ActionCopy {
  label: string;
  title: string;
  body: string;
  confirm: string;
  danger?: boolean;
  reasonLabel?: string;
}
interface CopyKeys {
  label: MessageKey;
  title: MessageKey;
  body: MessageKey;
  confirm: MessageKey;
  danger?: boolean;
  reasonLabel?: MessageKey;
}

/** Copy whose text fields are looked up in the current language each time they are read. */
function copy({ danger, ...keys }: CopyKeys): ActionCopy {
  const o = {} as ActionCopy;
  if (danger) o.danger = true;
  for (const [k, key] of Object.entries(keys)) Object.defineProperty(o, k, { enumerable: true, get: () => t(key) });
  return Object.freeze(o);
}

export const ACTION_COPY: Record<ReviewAction, ActionCopy> = {
  approve: copy({
    label: 'coaching.admin.approve',
    title: 'coaching.admin.approve_this_coach',
    body: 'coaching.admin.they_become_an_approved_coach_if',
    confirm: 'coaching.admin.approve',
    reasonLabel: 'coaching.admin.note_to_the_coach_optional',
  }),
  request_changes: copy({
    label: 'coaching.admin.request_changes',
    title: 'coaching.admin.request_changes',
    body: 'coaching.admin.the_application_goes_back_to_the',
    confirm: 'coaching.client.send_feedback',
    reasonLabel: 'coaching.admin.what_should_they_change',
  }),
  reject: copy({
    label: 'coaching.admin.reject',
    title: 'coaching.admin.reject_this_application',
    body: 'coaching.admin.the_applicant_is_told_it_wasnt',
    confirm: 'coaching.admin.reject',
    danger: true,
    reasonLabel: 'coaching.admin.reason_shown_to_the_applicant',
  }),
  suspend: copy({
    label: 'coaching.admin.suspend',
    title: 'coaching.admin.suspend_this_coach',
    body: 'coaching.admin.their_listing_is_removed_and_their',
    confirm: 'coaching.admin.suspend_coach',
    danger: true,
    reasonLabel: 'coaching.admin.reason_shown_to_the_coach',
  }),
  reinstate: copy({
    label: 'coaching.admin.reinstate',
    title: 'coaching.admin.reinstate_this_coach',
    body: 'coaching.admin.their_coach_access_returns_their_listing',
    confirm: 'coaching.admin.reinstate',
    reasonLabel: 'coaching.admin.note_optional',
  }),
  approve_qualification: copy({
    label: 'coaching.admin.approve',
    title: 'coaching.admin.mark_qualification_as_reviewed',
    body: 'coaching.admin.it_appears_on_the_coachs_public',
    confirm: 'coaching.admin.mark_reviewed',
    reasonLabel: 'coaching.admin.note_optional',
  }),
  reject_qualification: copy({
    label: 'coaching.admin.reject',
    title: 'coaching.admin.reject_this_qualification',
    body: 'coaching.admin.it_stays_hidden_from_the_public',
    confirm: 'coaching.admin.reject_qualification',
    danger: true,
    reasonLabel: 'coaching.admin.reason_shown_to_the_coach',
  }),
};
