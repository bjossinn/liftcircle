/**
 * Coaching before the sign-in gate: what a human coach and the AI coach are, what each can see, that both
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

/* ------------------------------------------------------------ directory */
type Format = 'any' | 'in_person' | 'online';

export function PublicFindCoach() {
  const { account } = useApp();
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
    { fallback: 'Couldn’t load coaches.' },
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
  return (
    <div className="flex flex-col gap-3">
      <Notice>
        You’re looking as a guest.{' '}
        <Link to={authLink('/coaching/find')} className="text-accent font-medium underline underline-offset-2">
          Sign in
        </Link>{' '}
        to request coaching, see photos and search by distance.
      </Notice>
      <form onSubmit={submit} className="flex flex-col gap-3" role="search" aria-label="Search coaches">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input label="Town or city" value={city} onChange={(e) => setCity(e.target.value)} autoComplete="address-level2" enterKeyHint="search" />
          <Select label="Country" value={country} onChange={(e) => setCountry(e.target.value)}>
            <option value="">Any country</option>
            {countryOptions().map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
        <Segmented<Format>
          label="Coaching format"
          value={format}
          onChange={setFormat}
          options={[
            { value: 'any', label: 'Any' },
            { value: 'in_person', label: 'In person' },
            { value: 'online', label: 'Online' },
          ]}
        />
        <Button type="submit" variant="primary" icon={<Search className="size-4" aria-hidden />}>
          Search
        </Button>
      </form>
      <SectionTitle>{query.city || query.country ? 'Coaches' : 'Online coaches'}</SectionTitle>
      {res.loading && !res.data ? (
        <Spinner label="Loading coaches" />
      ) : items.length === 0 ? (
        <EmptyState icon={<Search className="size-5" aria-hidden />} title="No coaches found" body="Try another town, a whole country, or online coaching." />
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Coaches">
          {items.map((c) => (
            <CoachCardView key={c.userId} coach={c} />
          ))}
        </ul>
      )}
      {hasMore && (
        <Button onClick={more} loading={moreBusy}>
          Show more coaches
        </Button>
      )}
      <GuestChoicesLink />
    </div>
  );
}

function GuestChoicesLink() {
  return (
    <Link to="/coaching" className="text-sm text-accent font-medium min-h-11 inline-flex items-center px-1">
      Human coach or AI coach? Compare the options
    </Link>
  );
}

/* -------------------------------------------------------------- profile */
export function PublicCoachProfile({ coachId }: { coachId: string }) {
  const nav = useNavigate();
  const coach = useLoad(() => publicCoachDirectory.get(coachId), [coachId], { fallback: 'Couldn’t load this coach.' });
  if (coach.loading && coach.data === undefined) return <Spinner label="Loading coach" />;
  if (coach.error) return <GuestCoachingIntro browse={false} />;
  const c = coach.data;
  if (!c) {
    return (
      <EmptyState
        icon={<UserX className="size-6" aria-hidden />}
        title="This coach isn’t listed"
        body="The profile may have been unpublished or the link is wrong."
        action={
          <Link to="/coaching/find" className="inline-flex min-h-11 items-center px-4 rounded-xl border border-line hover:bg-surface-2">
            Find a coach
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
          {c.approvedSince && <p className="text-xs text-muted">Approved since {dateText(c.approvedSince)}</p>}
          {location && (
            <p className="text-sm text-muted inline-flex items-center gap-1.5">
              <MapPin className="size-3.5 shrink-0" aria-hidden />
              {location}
            </p>
          )}
        </div>
      </div>
      <p className={`mt-3 text-sm font-medium ${c.acceptingClients ? 'text-accent' : 'text-warn'}`}>{c.acceptingClients ? 'Accepting new clients' : 'Not taking new clients right now'}</p>
      <div className="mt-4 flex flex-col gap-2">
        <Button variant="primary" size="lg" block onClick={() => nav(authLink(`/coaching/coach/${encodeURIComponent(c.userId)}`))}>
          Sign in to request coaching
        </Button>
        <p className="text-xs text-muted px-1">Requests need an account. The coach sees only your request and intro until they accept.</p>
      </div>
      {c.bio && (
        <>
          <SectionTitle>About</SectionTitle>
          <Card className="p-4">
            <p className="text-[15px] whitespace-pre-line break-words">{c.bio}</p>
          </Card>
        </>
      )}
      <SectionTitle>Coaching</SectionTitle>
      <Card className="px-4 py-2">
        <dl className="divide-y divide-line">
          <FactRow label="Format">
            <span className="inline-flex items-center gap-1.5">
              <Globe className="size-4 text-muted" aria-hidden />
              {formatsText(c.formats)}
            </span>
          </FactRow>
          {c.languages.length > 0 && (
            <FactRow label="Languages">
              <span className="inline-flex items-center gap-1.5">
                <MessageSquare className="size-4 text-muted" aria-hidden />
                {c.languages.map(languageName).join(', ')}
              </span>
            </FactRow>
          )}
          {c.specialties.length > 0 && (
            <FactRow label="Specialties">
              <div className="pt-1">
                <TagList label="Specialties" items={c.specialties.map(specialtyLabel)} />
              </div>
            </FactRow>
          )}
          {c.goals.length > 0 && (
            <FactRow label="Helps clients with">
              <div className="pt-1">
                <TagList label="Goals" items={c.goals.map(coachGoalLabel)} />
              </div>
            </FactRow>
          )}
          {c.serviceAreas.length > 0 && (
            <FactRow label="Service areas">
              <ul className="flex flex-col gap-0.5">
                {c.serviceAreas.map((a, i) => (
                  <li key={a.id ?? i}>
                    {areaText(a)}
                    {a.radiusKm ? ` (travels up to ${Math.round(a.radiusKm)} km)` : ''}
                  </li>
                ))}
              </ul>
            </FactRow>
          )}
        </dl>
      </Card>
      {(c.experience || c.experienceYears != null) && (
        <>
          <SectionTitle>Experience</SectionTitle>
          <Card className="p-4 flex flex-col gap-2">
            {c.experienceYears != null && (
              <p className="font-medium">
                {c.experienceYears} year{c.experienceYears === 1 ? '' : 's'} coaching
              </p>
            )}
            {c.experience && <p className="text-[15px] whitespace-pre-line break-words">{c.experience}</p>}
          </Card>
        </>
      )}
      {c.approvedQualifications.length > 0 && (
        <>
          <SectionTitle>Qualifications</SectionTitle>
          <Card className="overflow-hidden">
            <ul className="divide-y divide-line">
              {c.approvedQualifications.map((q) => (
                <li key={q.id} className="flex items-start gap-3 px-4 py-3">
                  <Award className="size-5 text-accent shrink-0 mt-0.5" aria-hidden />
                  <div className="min-w-0">
                    <p className="font-medium break-words">{q.title}</p>
                    <p className="text-xs text-muted">{[q.issuer, q.year].filter(Boolean).join(' · ')}</p>
                    <p className="text-xs text-accent mt-0.5">Qualification reviewed</p>
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
