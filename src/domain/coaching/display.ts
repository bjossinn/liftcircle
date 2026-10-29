/** Display text for coaching records (pure). */
import type { ApplicationStatus, CoachFormat, ReviewEvent, ServiceArea } from '@/backend/coachingContract';
import { countryName, FORMAT_LABELS } from './options';

export function areaText(a: Pick<ServiceArea, 'kind' | 'city' | 'region' | 'country'>): string {
  const parts = a.kind === 'country' ? [] : a.kind === 'region' ? [a.region] : [a.city, a.region];
  return [...parts.filter((p): p is string => !!p && !!p.trim()), countryName(a.country)].filter(Boolean).join(', ');
}

/** Service area with the coach's published in-person travel radius, when they set one. */
export function areaWithRadius(a: ServiceArea): string {
  const base = areaText(a);
  return a.radiusKm && a.lat != null && a.lng != null ? `${base} (travels up to ${Math.round(a.radiusKm)} km)` : base;
}

export function locationText(c: { city?: string | null; region?: string | null; country?: string | null }): string {
  return [c.city, c.region, c.country ? countryName(c.country) : null].filter((p): p is string => !!p && !!p.trim()).join(', ');
}

export function formatsText(f: CoachFormat[]): string {
  if (f.includes('in_person') && f.includes('online')) return 'In person and online';
  if (f.length === 0) return 'Format not set';
  return f.map((x) => FORMAT_LABELS[x]).join(', ');
}

export const STATUS_LABELS: Record<ApplicationStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted for review',
  changes_requested: 'Changes requested',
  approved: 'Approved coach',
  rejected: 'Not approved',
};

export const STATUS_TONE: Record<ApplicationStatus, 'neutral' | 'accent' | 'warn' | 'danger' | 'info'> = {
  draft: 'neutral',
  submitted: 'info',
  changes_requested: 'warn',
  approved: 'accent',
  rejected: 'danger',
};

export const EVENT_LABELS: Record<ReviewEvent['action'], string> = {
  submitted: 'Submitted',
  resubmitted: 'Resubmitted',
  qualifications_changed: 'Qualification details changed',
  approve: 'Approved',
  request_changes: 'Changes requested',
  reject: 'Not approved',
  suspend: 'Suspended',
  reinstate: 'Reinstated',
  approve_qualification: 'Qualification reviewed',
  reject_qualification: 'Qualification not accepted',
};

export function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('') || '?'
  );
}

export function dateText(iso: string | null | undefined, withTime = false): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!isFinite(ms)) return '';
  return new Intl.DateTimeFormat('en-GB', withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' }).format(ms);
}
