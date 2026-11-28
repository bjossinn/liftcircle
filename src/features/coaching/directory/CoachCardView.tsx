import { Link } from 'react-router';
import { ChevronRight, Globe, MapPin, MessageSquare } from 'lucide-react';
import type { CoachCard } from '@/backend/coachingContract';
import { Card } from '@/components/ui';
import { areaText, formatsText, locationText } from '@/domain/coaching/display';
import { languageName, specialtyLabel } from '@/domain/coaching/options';
import { distanceText } from '@/domain/coaching/search';
import { t as tr, useT, type Language } from '@/i18n';
import { ApprovedBadge, CoachPhoto, TagList } from './common';

export function serviceAreaSummary(c: Pick<CoachCard, 'serviceAreas' | 'city' | 'region' | 'country'>, max = 2, language?: Language): string {
  const areas = c.serviceAreas.map((a) => areaText(a)).filter(Boolean);
  if (areas.length === 0) return locationText(c);
  const shown = areas.slice(0, max).join(' · ');
  return areas.length > max ? tr('coaching.directory.x_more', { areas: shown, count: areas.length - max }, language) : shown;
}

export function CoachCardView({ coach }: { coach: CoachCard }) {
  const { t, language } = useT();
  const dist = coach.match === 'local' ? distanceText(coach.distanceKm) : null;
  const where = serviceAreaSummary(coach, 2, language);
  return (
    <Card as="li" className="overflow-hidden">
      <Link to={`/coaching/coach/${encodeURIComponent(coach.userId)}`} className="flex gap-3 p-4 hover:bg-surface-2 transition-colors focus-visible:outline-2 focus-visible:outline-accent">
        <CoachPhoto name={coach.displayName} url={coach.photoUrl} />
        <div className="min-w-0 flex-1 flex flex-col gap-1.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="font-semibold text-[16px] truncate">{coach.displayName}</h3>
              <ApprovedBadge />
            </div>
            <ChevronRight className="size-5 text-muted shrink-0 mt-0.5" aria-hidden />
          </div>
          {coach.specialties.length > 0 && <TagList label={t('coaching.directory.specialties')} items={coach.specialties.slice(0, 4).map(specialtyLabel)} />}
          <dl className="text-xs text-muted flex flex-col gap-1">
            {where && (
              <div className="flex items-start gap-1.5">
                <dt className="sr-only">{t('coaching.directory.service_area')}</dt>
                <MapPin className="size-3.5 shrink-0 mt-0.5" aria-hidden />
                <dd className="min-w-0">
                  {where}
                  {dist && <span className="text-ink"> · {dist}</span>}
                </dd>
              </div>
            )}
            <div className="flex items-start gap-1.5">
              <dt className="sr-only">{t('coaching.directory.format')}</dt>
              <Globe className="size-3.5 shrink-0 mt-0.5" aria-hidden />
              <dd>{formatsText(coach.formats, language)}</dd>
            </div>
            {coach.languages.length > 0 && (
              <div className="flex items-start gap-1.5">
                <dt className="sr-only">{t('coaching.directory.languages')}</dt>
                <MessageSquare className="size-3.5 shrink-0 mt-0.5" aria-hidden />
                <dd>{coach.languages.map((l) => languageName(l, language)).join(', ')}</dd>
              </div>
            )}
          </dl>
          <p className={coach.acceptingClients ? 'text-xs font-medium text-accent' : 'text-xs font-medium text-warn'}>
            {coach.acceptingClients ? t('coaching.apply.accepting_new_clients') : t('coaching.directory.not_taking_new_clients_right_now')}
          </p>
        </div>
      </Link>
    </Card>
  );
}
