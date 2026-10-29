/** Admin review rules mirrored on the client (the server re-checks current status on every action). Pure. */
import type { ApplicationStatus, CoachProfile, ReviewAction } from '@/backend/coachingContract';

export type QueueTab = ApplicationStatus | 'suspended' | 'qualifications_pending';
export const QUEUE_TABS: { value: Exclude<QueueTab, 'draft'>; label: string }[] = [
  { value: 'submitted', label: 'Submitted' },
  { value: 'changes_requested', label: 'Changes requested' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'qualifications_pending', label: 'Qualifications pending' },
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
  const t = reason.trim();
  if (reasonRequired(a) && !t) return a === 'request_changes' ? 'Tell the applicant what to change.' : 'Add a reason. The coach will see it.';
  if (t.length > REASON_MAX) return `At most ${REASON_MAX} characters.`;
  return null;
}

export const ACTION_COPY: Record<ReviewAction, { label: string; title: string; body: string; confirm: string; danger?: boolean; reasonLabel?: string }> = {
  approve: {
    label: 'Approve',
    title: 'Approve this coach?',
    body: 'They become an “Approved coach”. If they’ve chosen to publish a listing, it appears in the directory and they can accept clients.',
    confirm: 'Approve',
    reasonLabel: 'Note to the coach (optional)',
  },
  request_changes: {
    label: 'Request changes',
    title: 'Request changes',
    body: 'The application goes back to the applicant with your feedback. They can edit and resubmit.',
    confirm: 'Send feedback',
    reasonLabel: 'What should they change?',
  },
  reject: {
    label: 'Reject',
    title: 'Reject this application?',
    body: 'The applicant is told it wasn’t approved and sees your reason. They can edit and apply again.',
    confirm: 'Reject',
    danger: true,
    reasonLabel: 'Reason (shown to the applicant)',
  },
  suspend: {
    label: 'Suspend',
    title: 'Suspend this coach?',
    body: 'Their listing is removed and their coach access stops immediately, even in open sessions. Their clients are notified that coaching is paused. Clients keep their workouts and accepted programs.',
    confirm: 'Suspend coach',
    danger: true,
    reasonLabel: 'Reason (shown to the coach)',
  },
  reinstate: {
    label: 'Reinstate',
    title: 'Reinstate this coach?',
    body: 'Their coach access returns. Their listing shows again if they’ve chosen to publish it.',
    confirm: 'Reinstate',
    reasonLabel: 'Note (optional)',
  },
  approve_qualification: {
    label: 'Approve',
    title: 'Mark qualification as reviewed?',
    body: 'It appears on the coach’s public profile as “Qualification reviewed”. Only confirm if you checked the details or document.',
    confirm: 'Mark reviewed',
    reasonLabel: 'Note (optional)',
  },
  reject_qualification: {
    label: 'Reject',
    title: 'Reject this qualification?',
    body: 'It stays hidden from the public profile. The coach sees your note and can update it.',
    confirm: 'Reject qualification',
    danger: true,
    reasonLabel: 'Reason (shown to the coach)',
  },
};
