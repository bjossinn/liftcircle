/** Display text for coaching records (pure). */
import type { ApplicationStatus, CoachFormat, ReviewEvent, ServiceArea } from '@/backend/coachingContract';
import { getLanguage, localeFor, t, type Language, type MessageKey } from '@/i18n';
import { countryName, formatLabel } from './options';

/** Record whose values are message lookups, read in the current language on every access. */
function liveRecord<K extends string>(keys: Record<K, MessageKey>): Record<K, string> {
  const o = {} as Record<K, string>;
  for (const k of Object.keys(keys) as K[]) Object.defineProperty(o, k, { enumerable: true, get: () => t(keys[k]) });
  return Object.freeze(o);
}

export function areaText(a: Pick<ServiceArea, 'kind' | 'city' | 'region' | 'country'>): string {
  const parts = a.kind === 'country' ? [] : a.kind === 'region' ? [a.region] : [a.city, a.region];
  return [...parts.filter((p): p is string => !!p && !!p.trim()), countryName(a.country)].filter(Boolean).join(', ');
}

/** Service area with the coach's published in-person travel radius, when they set one. */
export function areaWithRadius(a: ServiceArea): string {
  const base = areaText(a);
  return a.radiusKm && a.lat != null && a.lng != null ? `${base} ${t('coaching.directory.travels_up_to_x_km', { km: Math.round(a.radiusKm) })}` : base;
}

export function locationText(c: { city?: string | null; region?: string | null; country?: string | null }): string {
  return [c.city, c.region, c.country ? countryName(c.country) : null].filter((p): p is string => !!p && !!p.trim()).join(', ');
}

export function formatsText(f: CoachFormat[], language: Language = getLanguage()): string {
  if (f.includes('in_person') && f.includes('online')) return t('coaching.directory.in_person_and_online', undefined, language);
  if (f.length === 0) return t('coaching.directory.format_not_set', undefined, language);
  return f.map((x) => formatLabel(x, language)).join(', ');
}

export const STATUS_LABELS: Record<ApplicationStatus, string> = liveRecord<ApplicationStatus>({
  draft: 'coaching.status.draft',
  submitted: 'coaching.status.submitted',
  changes_requested: 'coaching.status.changes_requested',
  approved: 'coaching.status.approved',
  rejected: 'coaching.status.rejected',
});

export const STATUS_TONE: Record<ApplicationStatus, 'neutral' | 'accent' | 'warn' | 'danger' | 'info'> = {
  draft: 'neutral',
  submitted: 'info',
  changes_requested: 'warn',
  approved: 'accent',
  rejected: 'danger',
};

export const EVENT_LABELS: Record<ReviewEvent['action'], string> = liveRecord<ReviewEvent['action']>({
  submitted: 'coaching.event.submitted',
  resubmitted: 'coaching.event.resubmitted',
  qualifications_changed: 'coaching.event.qualifications_changed',
  approve: 'coaching.event.approve',
  request_changes: 'coaching.event.request_changes',
  reject: 'coaching.event.reject',
  suspend: 'coaching.event.suspend',
  reinstate: 'coaching.event.reinstate',
  approve_qualification: 'coaching.event.approve_qualification',
  reject_qualification: 'coaching.event.reject_qualification',
});

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

export function dateText(iso: string | null | undefined, withTime = false, language: Language = getLanguage()): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!isFinite(ms)) return '';
  return new Intl.DateTimeFormat(localeFor(language), withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' }).format(ms);
}
