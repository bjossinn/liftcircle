import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Award, ChevronLeft, Flag, Globe, MapPin, MessageSquare, UserX } from 'lucide-react';
import { coachingApi } from '@/backend/coaching';
import { Card, EmptyState, ErrorState, IconButton, Notice, Page, SectionTitle, Spinner } from '@/components/ui';
import { ReportSheet } from '@/features/social/common';
import { areaWithRadius, dateText, formatsText, locationText } from '@/domain/coaching/display';
import { REQUEST_BLOCK_TEXT, requestBlock } from '@/domain/coaching/eligibility';
import { coachGoalLabel, languageName, specialtyLabel } from '@/domain/coaching/options';
import { distanceText } from '@/domain/coaching/search';
import { ApprovedBadge, CoachPhoto, CoachingAccessNotice, FactRow, TagList, useCoachingAccess, useLoad } from './directory/common';
import { PublicCoachProfile } from './directory/PublicDirectory';

export default function CoachProfilePage() {
  const nav = useNavigate();
  const { id } = useParams();
  const { access, meId } = useCoachingAccess();
  return (
    <Page
      title="Coach"
      back={
        <IconButton label="Back" onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
    >
      {access === 'guest' && id ? (
        <PublicCoachProfile coachId={id} />
      ) : access !== 'ok' ? (
        <CoachingAccessNotice access={access} />
      ) : id ? (
        <CoachProfile coachId={id} meId={meId} />
      ) : (
        <EmptyState title="Coach not found" />
      )}
    </Page>
  );
}

function CoachProfile({ coachId, meId }: { coachId: string; meId: string | undefined }) {
  const coach = useLoad(() => coachingApi.getCoach(coachId), [coachId], { fallback: 'Couldn’t load this coach.' });
  const rels = useLoad(() => coachingApi.myRelationships(), []);
  const [reportOpen, setReportOpen] = useState(false);

  if (coach.loading && coach.data === undefined) return <Spinner label="Loading coach" />;
  if (coach.error) return <ErrorState title="Couldn’t load this coach" message={coach.error} onRetry={coach.reload} />;
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

  // When relationships fail to load we still allow the request; the server re-checks every rule.
  const block = requestBlock({ coachId: c.userId, acceptingClients: c.acceptingClients, meId, relationships: rels.data });
  const dist = c.match === 'local' ? distanceText(c.distanceKm) : null;
  const location = locationText(c);

  return (
    <>
      <div className="flex items-start gap-4 pt-2">
        <CoachPhoto name={c.displayName} url={c.photoUrl} size={88} />
        <div className="min-w-0 flex-1 flex flex-col gap-1.5">
          <h2 className="text-xl font-bold leading-tight break-words">{c.displayName}</h2>
          <ApprovedBadge />
          {c.approvedSince && <p className="text-xs text-muted">Approved since {dateText(c.approvedSince)}</p>}
          {location && (
            <p className="text-sm text-muted inline-flex items-center gap-1.5">
              <MapPin className="size-3.5 shrink-0" aria-hidden />
              {location}
              {dist ? ` · ${dist}` : ''}
            </p>
          )}
        </div>
      </div>

      <p className={`mt-3 text-sm font-medium ${c.acceptingClients ? 'text-accent' : 'text-warn'}`}>{c.acceptingClients ? 'Accepting new clients' : 'Not taking new clients right now'}</p>

      <div className="mt-4 flex flex-col gap-2">
        {block ? (
          <>
            <button type="button" disabled aria-describedby="request-blocked" className="w-full min-h-14 rounded-xl bg-disabled text-disabled-ink font-semibold cursor-not-allowed">
              Request coaching
            </button>
            <p id="request-blocked" className="text-sm text-muted">
              {REQUEST_BLOCK_TEXT[block]}
              {(block === 'already_coach' || block === 'pending' || block === 'too_many_pending') && (
                <>
                  {' '}
                  <Link to="/coaching/my" className="text-accent font-medium">
                    Go to My coach
                  </Link>
                </>
              )}
            </p>
          </>
        ) : (
          <Link
            to={`/coaching/request/${encodeURIComponent(c.userId)}`}
            className="w-full min-h-14 rounded-xl ember-fill font-semibold inline-flex items-center justify-center"
          >
            Request coaching
          </Link>
        )}
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
                {c.serviceAreas.map((a) => (
                  <li key={a.id}>{areaWithRadius(a)}</li>
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
            {c.experience && <p className="text-[15px] whitespace-pre-line break-words text-ink">{c.experience}</p>}
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
          <p className="text-xs text-muted px-1 mt-2">“Qualification reviewed” means our team looked at the details or document the coach supplied.</p>
        </>
      )}

      <Notice className="mt-6">Coaching is separate from friendship. A coach only sees what you choose to share when you send a request, and you can change it anytime.</Notice>

      {meId !== c.userId && (
        <button type="button" onClick={() => setReportOpen(true)} className="mt-4 inline-flex items-center gap-2 min-h-11 px-1 text-sm text-muted hover:text-danger">
          <Flag className="size-4" aria-hidden />
          Report this profile
        </button>
      )}
      <ReportSheet open={reportOpen} onClose={() => setReportOpen(false)} target={{ userId: c.userId }} what="coach profile" />
    </>
  );
}
