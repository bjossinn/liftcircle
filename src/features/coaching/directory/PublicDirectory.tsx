/**
 * Coaching before the sign-in gate: what a human coach and the training assistant are, what each can see, that both
 * need an account — plus a read-only preview of approved, listed coaches (public listing fields only,
 * no photos; see supabase/migrations/20261030000004_public_coach_preview.sql). Requesting coaching,
 * messages and all private data stay behind sign-in.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { Award, Globe, MapPin, MessageSquare, Search, UserX } from 'lucide-react';
import { publicCoachDirectory } from '@/backend/coaching';
import type { CoachCard } from '@/backend/coachingContract';
import { Button, Card, EmptyState, Input, Notice, SectionTitle, Segmented, Select, Spinner } from '@/components/ui';
import { useApp } from '@/state/app';
import { areaText, dateText, formatsText, locationText } from '@/domain/coaching/display';
import { coachGoalLabel, countryFromTimeZone, countryOptions, languageName, specialtyLabel } from '@/domain/coaching/options';
import { CoachCardView } from './CoachCardView';
import { ApprovedBadge, CoachPhoto, FactRow, GuestCoachingIntro, TagList, authLink, useLoad } from './common';
import { useT } from '@/i18n';

/* ------------------------------------------------------------ directory */
type Format = 'any' | 'in_person' | 'online';

export function PublicFindCoach() {
  const { account } = useApp();
  const { t, language } = useT();
  const countries = useMemo(() => countryOptions(language), [language]);
  const defaultCountry = useMemo(() => countryFromTimeZone(account.settings.timeZone), [account.settings.timeZone]);
  const [city, setCity] = useState('');
  const [country, setCountry] = useState(defaultCountry);
  const [format, setFormat] = useState<Format>('any');
  const [query, setQuery] = useState({ city: '', country: defaultCountry, format: 'any' as Format, n: 0 });
  const [extra, setExtra] = useState<CoachCard[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const res = useLoad(
    async () => {
      const r = await publicCoachDirectory.search({ city: query.city, country: query.country, format: query.format, limit: 20, offset: 0 });
      setExtra([]);
      setHasMore(r.hasMore);
      return r.items;
    },
    [query.n],
    { fallback: t('coaching.directory.couldnt_load_coaches') },
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setQuery({ city, country, format, n: query.n + 1 });
  };
  const more = async () => {
    setMoreBusy(true);
    try {
      const r = await publicCoachDirectory.search({ city: query.city, country: query.country, format: query.format, limit: 20, offset: (res.data?.length ?? 0) + extra.length });
      setExtra((x) => [...x, ...r.items]);
      setHasMore(r.hasMore);
    } catch {
      setHasMore(false);
    } finally {
      setMoreBusy(false);
    }
  };

  // The preview isn't available on this backend (or failed): fall back to the explanation + sign-in.
  if (res.error && !res.data) return <GuestCoachingIntro browse={false} />;
  const items = [...(res.data ?? []), ...extra];
  // "{{signIn}} to request coaching…": the link sits where the placeholder is, in either language's word order.
  const [signInBefore = '', signInAfter = ''] = t('coaching.directory.sign_in_to_request_coaching_see', { signIn: '\u0000' }).split('\u0000');
  return (
    <div className="flex flex-col gap-3">
      <Notice>
        {t('coaching.directory.youre_looking_as_a_guest')} {signInBefore}
        <Link to={authLink('/coaching/find')} className="text-accent font-medium underline underline-offset-2">
          {t('settings.signIn')}
        </Link>
        {signInAfter}
      </Notice>
      <form onSubmit={submit} className="flex flex-col gap-3" role="search" aria-label={t('coaching.directory.search_coaches')}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input label={t('coaching.directory.town_or_city')} value={city} onChange={(e) => setCity(e.target.value)} autoComplete="address-level2" enterKeyHint="search" />
          <Select label={t('coaching.directory.country')} value={country} onChange={(e) => setCountry(e.target.value)}>
            <option value="">{t('coaching.directory.any_country')}</option>
            {countries.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
        <Segmented<Format>
          label={t('coaching.directory.coaching_format')}
          value={format}
          onChange={setFormat}
          options={[
            { value: 'any', label: t('coaching.directory.any') },
            { value: 'in_person', label: t('coaching.directory.in_person') },
            { value: 'online', label: t('coaching.directory.online') },
          ]}
        />
        <Button type="submit" variant="primary" icon={<Search className="size-4" aria-hidden />}>
          {t('coaching.directory.search')}
        </Button>
      </form>
      <SectionTitle>{query.city || query.country ? t('coaching.directory.coaches') : t('coaching.directory.online_coaches')}</SectionTitle>
      {res.loading && !res.data ? (
        <Spinner label={t('coaching.directory.loading_coaches')} />
      ) : items.length === 0 ? (
        <EmptyState icon={<Search className="size-5" aria-hidden />} title={t('coaching.directory.no_coaches_found')} body={t('coaching.directory.try_another_town_a_whole_country')} />
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t('coaching.directory.coaches')}>
          {items.map((c) => (
            <CoachCardView key={c.userId} coach={c} />
          ))}
        </ul>
      )}
      {hasMore && (
        <Button onClick={more} loading={moreBusy}>
          {t('coaching.directory.show_more_coaches')}
        </Button>
      )}
      <GuestChoicesLink />
    </div>
  );
}

function GuestChoicesLink() {
  const { t } = useT();
  return (
    <Link to="/coaching" className="text-sm text-accent font-medium min-h-11 inline-flex items-center px-1">
      {t('coaching.directory.human_coach_or_training_assistant_compare')}
    </Link>
  );
}

/* -------------------------------------------------------------- profile */
export function PublicCoachProfile({ coachId }: { coachId: string }) {
  const nav = useNavigate();
  const { t, tp, language } = useT();
  const coach = useLoad(() => publicCoachDirectory.get(coachId), [coachId], { fallback: t('coaching.profile.couldnt_load_this_coach') });
  if (coach.loading && coach.data === undefined) return <Spinner label={t('coaching.profile.loading_coach')} />;
  if (coach.error) return <GuestCoachingIntro browse={false} />;
  const c = coach.data;
  if (!c) {
    return (
      <EmptyState
        icon={<UserX className="size-6" aria-hidden />}
        title={t('coaching.profile.this_coach_isnt_listed')}
        body={t('coaching.profile.the_profile_may_have_been_unpublished')}
        action={
          <Link to="/coaching/find" className="inline-flex min-h-11 items-center px-4 rounded-xl border border-line hover:bg-surface-2">
            {t('nav.findCoach')}
          </Link>
        }
      />
    );
  }
  const location = locationText(c);
  return (
    <>
      <div className="flex items-start gap-4 pt-2">
        <CoachPhoto name={c.displayName} url={null} size={88} />
        <div className="min-w-0 flex-1 flex flex-col gap-1.5">
          <h2 className="text-xl font-bold leading-tight break-words">{c.displayName}</h2>
          <ApprovedBadge />
          {c.approvedSince && <p className="text-xs text-muted">{t('coaching.profile.approved_since_x', { date: dateText(c.approvedSince, false, language) })}</p>}
          {location && (
            <p className="text-sm text-muted inline-flex items-center gap-1.5">
              <MapPin className="size-3.5 shrink-0" aria-hidden />
              {location}
            </p>
          )}
        </div>
      </div>
      <p className={`mt-3 text-sm font-medium ${c.acceptingClients ? 'text-accent' : 'text-warn'}`}>{c.acceptingClients ? t('coaching.apply.accepting_new_clients') : t('coaching.directory.not_taking_new_clients_right_now')}</p>
      <div className="mt-4 flex flex-col gap-2">
        <Button variant="primary" size="lg" block onClick={() => nav(authLink(`/coaching/coach/${encodeURIComponent(c.userId)}`))}>
          {t('coaching.directory.sign_in_to_request_coaching')}
        </Button>
        <p className="text-xs text-muted px-1">{t('coaching.directory.requests_need_an_account_the_coach')}</p>
      </div>
      {c.bio && (
        <>
          <SectionTitle>{t('coaching.profile.about')}</SectionTitle>
          <Card className="p-4">
            <p className="text-[15px] whitespace-pre-line break-words">{c.bio}</p>
          </Card>
        </>
      )}
      <SectionTitle>{t('ai.channels.human')}</SectionTitle>
      <Card className="px-4 py-2">
        <dl className="divide-y divide-line">
          <FactRow label={t('coaching.directory.format')}>
            <span className="inline-flex items-center gap-1.5">
              <Globe className="size-4 text-muted" aria-hidden />
              {formatsText(c.formats, language)}
            </span>
          </FactRow>
          {c.languages.length > 0 && (
            <FactRow label={t('coaching.directory.languages')}>
              <span className="inline-flex items-center gap-1.5">
                <MessageSquare className="size-4 text-muted" aria-hidden />
                {c.languages.map((l) => languageName(l, language)).join(', ')}
              </span>
            </FactRow>
          )}
          {c.specialties.length > 0 && (
            <FactRow label={t('coaching.directory.specialties')}>
              <div className="pt-1">
                <TagList label={t('coaching.directory.specialties')} items={c.specialties.map(specialtyLabel)} />
              </div>
            </FactRow>
          )}
          {c.goals.length > 0 && (
            <FactRow label={t('coaching.profile.helps_clients_with')}>
              <div className="pt-1">
                <TagList label={t('progress.goals')} items={c.goals.map(coachGoalLabel)} />
              </div>
            </FactRow>
          )}
          {c.serviceAreas.length > 0 && (
            <FactRow label={t('coaching.admin.service_areas')}>
              <ul className="flex flex-col gap-0.5">
                {c.serviceAreas.map((a, i) => (
                  <li key={a.id ?? i}>
                    {areaText(a)}
                    {a.radiusKm ? ` ${t('coaching.directory.travels_up_to_x_km', { km: Math.round(a.radiusKm) })}` : ''}
                  </li>
                ))}
              </ul>
            </FactRow>
          )}
        </dl>
      </Card>
      {(c.experience || c.experienceYears != null) && (
        <>
          <SectionTitle>{t('onboarding.experience.group')}</SectionTitle>
          <Card className="p-4 flex flex-col gap-2">
            {c.experienceYears != null && (
              <p className="font-medium">
                {tp('coaching.profile.years_coaching', c.experienceYears)}
              </p>
            )}
            {c.experience && <p className="text-[15px] whitespace-pre-line break-words">{c.experience}</p>}
          </Card>
        </>
      )}
      {c.approvedQualifications.length > 0 && (
        <>
          <SectionTitle>{t('coaching.admin.qualifications')}</SectionTitle>
          <Card className="overflow-hidden">
            <ul className="divide-y divide-line">
              {c.approvedQualifications.map((q) => (
                <li key={q.id} className="flex items-start gap-3 px-4 py-3">
                  <Award className="size-5 text-accent shrink-0 mt-0.5" aria-hidden />
                  <div className="min-w-0">
                    <p className="font-medium break-words">{q.title}</p>
                    <p className="text-xs text-muted">{[q.issuer, q.year].filter(Boolean).join(' · ')}</p>
                    <p className="text-xs text-accent mt-0.5">{t('coaching.profile.qualification_reviewed')}</p>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
      <div className="mt-4">
        <GuestChoicesLink />
      </div>
    </>
  );
}
