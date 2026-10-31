/**
 * /coaching/my — the client's side of coaching: current coach, open requests, sharing permissions,
 * program proposals, check-ins, workout feedback, ending or switching coaches.
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { CalendarRange, ClipboardCheck, HeartHandshake, MessageCircle, Repeat, Search, Sparkles, UserX } from 'lucide-react';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, ListRow, Notice, Page, SectionTitle, Spinner, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import { coachingApi } from '@/backend/coaching';
import type { CheckIn, CoachFeedback, CoachingRelationship } from '@/backend/coachingContract';
import { alive, saveRecord } from '@/db/repo';
import { takeOverPlan } from '@/domain/program/proposals';
import { formatDate } from '@/lib/dates';
import { coachingError } from '@/coaching/errors';
import { RELATIONSHIP_STATUS_LABEL, closedExplanation, sortClientRelationships } from '@/coaching/relationship';
import { Avatar } from '@/features/social/common';
import { BackButton, CheckInAnswers, CoachingAccessNotice, ProposalStatusBadge, ScopeEditor, fmtDateTime, useCoachingAccess, useLoad, useScrollToHash } from './tools/common';

export default function MyCoachPage() {
  const nav = useNavigate();
  const { access } = useCoachingAccess();
  const ok = access === 'ok';
  const rels = useLoad(async () => sortClientRelationships((await coachingApi.myRelationships()).filter((r) => !r.viewerIsCoach)), [], ok);

  const active = rels.data?.find((r) => r.status === 'active') ?? null;
  const requested = rels.data?.filter((r) => r.status === 'requested') ?? [];
  const closed = rels.data?.filter((r) => r.status === 'ended' || r.status === 'declined' || r.status === 'cancelled') ?? [];
  useScrollToHash(!!rels.data);

  return (
    <Page title="My coach" back={<BackButton to="/coaching" />}>
      <TakeOverNotice activeRelationshipIds={active ? [active.id] : []} ready={!!rels.data} />
      {!ok ? (
        <CoachingAccessNotice access={access} what="Your coaching details" />
      ) : rels.error && !rels.data ? (
        <ErrorState title="Couldn’t load your coaching" message={rels.error} onRetry={rels.reload} />
      ) : !rels.data ? (
        <Spinner label="Loading your coaching" />
      ) : rels.data.length === 0 ? (
        <EmptyState
          icon={<HeartHandshake className="size-6" aria-hidden />}
          title="No coach yet"
          body="Find an approved coach near you or online. You choose what to share, and you can change it or end coaching at any time."
          action={
            <div className="flex flex-col gap-2 w-full max-w-xs">
              <Button variant="primary" icon={<Search className="size-4" />} onClick={() => nav('/coaching/find')}>
                Look for a coach
              </Button>
              <Button icon={<Sparkles className="size-4" />} onClick={() => nav('/coaching/ai')}>
                Try the training assistant
              </Button>
            </div>
          }
        />
      ) : (
        <>
          {active && <ActiveCoach rel={active} onChanged={rels.reload} />}
          {requested.map((r) => (
            <PendingRequest key={r.id} rel={r} onChanged={rels.reload} />
          ))}
          {!active && requested.length === 0 && (
            <Card className="px-4 py-4 mt-2">
              <p className="text-sm">You don’t have an active coach right now.</p>
              <Button className="mt-3" variant="primary" icon={<Search className="size-4" />} onClick={() => nav('/coaching/find')}>
                Look for a coach
              </Button>
            </Card>
          )}
          {closed.length > 0 && (
            <>
              <SectionTitle>Past coaching</SectionTitle>
              <ul className="flex flex-col gap-2">
                {closed.slice(0, 5).map((r) => (
                  <Card as="li" key={r.id} className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Avatar profile={{ displayName: r.coach.displayName, username: '', avatarUrl: r.coach.photoUrl }} size={36} />
                      <div className="min-w-0 flex-1">
                        <p className="font-medium truncate">{r.coach.displayName}</p>
                        <p className="text-xs text-muted">
                          {RELATIONSHIP_STATUS_LABEL[r.status]} · {fmtDateTime(r.endedAt ?? r.respondedAt ?? r.requestedAt)}
                        </p>
                      </div>
                      {r.status === 'ended' && (
                        <Button size="sm" variant="ghost" icon={<MessageCircle className="size-4" />} onClick={() => nav(`/coaching/messages/${r.id}`)}>
                          History
                        </Button>
                      )}
                    </div>
                    <p className="text-sm text-muted mt-2">{closedExplanation(r)}</p>
                  </Card>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </Page>
  );
}

/* ================================================================ active coach */
function ActiveCoach({ rel, onChanged }: { rel: CoachingRelationship; onChanged: () => Promise<void> }) {
  const nav = useNavigate();
  const toast = useToast();
  const { db, account } = useApp();
  const unit = account.settings.units.weight;
  const name = rel.coach.displayName || 'Your coach';
  const proposals = useLoad(() => coachingApi.listProposals({ relationshipId: rel.id }), [rel.id]);
  const checkins = useLoad(() => coachingApi.listCheckIns(rel.id), [rel.id]);
  const feedback = useLoad(() => coachingApi.listFeedback(rel.id), [rel.id]);
  const sessions = useLiveQuery(() => db.sessions.toArray(), [db]);
  const sessionById = useMemo(() => new Map(alive(sessions ?? []).map((s) => [s.id, s])), [sessions]);

  const [ending, setEnding] = useState(false);
  const [endReason, setEndReason] = useState('');
  const [busy, setBusy] = useState(false);

  const pending = (proposals.data ?? []).filter((p) => p.status === 'sent');
  const past = (proposals.data ?? []).filter((p) => p.status !== 'sent' && p.status !== 'draft').sort((a, b) => (b.respondedAt ?? b.sentAt ?? '').localeCompare(a.respondedAt ?? a.sentAt ?? ''));

  const end = async () => {
    setBusy(true);
    try {
      await coachingApi.endCoaching(rel.id, endReason.trim() || undefined);
      setEnding(false);
      toast.show(`Coaching with ${name} has ended.`, { tone: 'success' });
      await onChanged();
    } catch (e) {
      toast.show(coachingError(e, 'Couldn’t end coaching. Try again.'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {rel.coach.suspended && (
        <Notice tone="warn" className="mb-3">
          Your coach’s account is currently suspended. Your data and current plan stay yours; messaging is paused.
        </Notice>
      )}
      <Card className="px-4 py-4">
        <div className="flex items-center gap-3">
          <Avatar profile={{ displayName: name, username: '', avatarUrl: rel.coach.photoUrl }} size={52} />
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold leading-tight truncate">{name}</h2>
            <p className="text-sm text-muted">Your coach{rel.respondedAt ? ` since ${fmtDateTime(rel.respondedAt)}` : ''}</p>
            <div className="mt-1.5 flex gap-1.5 flex-wrap">
              <Badge tone="accent">Active</Badge>
              {rel.coach.approved && !rel.coach.suspended && <Badge>Listed coach</Badge>}
            </div>
          </div>
        </div>
        <div className="mt-3 flex gap-2 flex-wrap">
          <Button variant="primary" icon={<MessageCircle className="size-4" />} onClick={() => nav(`/coaching/messages/${rel.id}`)}>
            Messages{rel.unread > 0 ? ` (${rel.unread} new)` : ''}
          </Button>
          <Button icon={<ClipboardCheck className="size-4" />} onClick={() => nav(`/coaching/checkin/${rel.id}`)}>
            New check-in
          </Button>
        </div>
        {rel.coach.approved && <p className="text-xs text-muted mt-3">“Listed coach” means Hard Earned reviewed and approved this coach’s application.</p>}
      </Card>

      <SectionTitle id="sharing">What you share with {name}</SectionTitle>
      <ScopeEditor
        scopes={rel.scopes}
        onSave={async (s) => {
          await coachingApi.setScopes(rel.id, s);
          await onChanged();
        }}
      />

      <SectionTitle>Program proposals</SectionTitle>
      {proposals.error && !proposals.data ? (
        <ErrorState title="Couldn’t load proposals" message={proposals.error} onRetry={proposals.reload} />
      ) : !proposals.data ? (
        <Spinner label="Loading proposals" />
      ) : pending.length === 0 && past.length === 0 ? (
        <Card className="px-4 py-3 text-sm text-muted">No programs from {name} yet. When they send one, you can preview it before deciding.</Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {pending.map((p) => (
              <li key={p.id}>
                <ListRow
                  left={<CalendarRange className="size-5 text-accent" aria-hidden />}
                  title={p.program.name}
                  subtitle={`Revision ${p.revision} · sent ${fmtDateTime(p.sentAt)} · waiting for you`}
                  right={<Badge tone="accent">Review</Badge>}
                  onClick={() => nav(`/coaching/proposal/${p.id}`)}
                />
              </li>
            ))}
            {past.slice(0, 6).map((p) => (
              <li key={p.id}>
                <ListRow title={p.program.name} subtitle={`Revision ${p.revision} · ${fmtDateTime(p.respondedAt ?? p.sentAt)}`} right={<ProposalStatusBadge status={p.status} />} onClick={() => nav(`/coaching/proposal/${p.id}`)} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      <SectionTitle
        action={
          <Button size="sm" variant="ghost" onClick={() => nav(`/coaching/checkin/${rel.id}`)}>
            New check-in
          </Button>
        }
      >
        Check-ins
      </SectionTitle>
      <CheckInList data={checkins.data} error={checkins.error} reload={checkins.reload} unit={unit} coachName={name} shared={rel.scopes.checkins} />

      <SectionTitle>Feedback on your workouts</SectionTitle>
      <FeedbackList data={feedback.data} error={feedback.error} reload={feedback.reload} sessionName={(id) => {
        const s = id ? sessionById.get(id) : undefined;
        return s ? `${s.name} · ${formatDate(s.date)}` : id ? 'A workout' : 'General';
      }} />

      <SectionTitle>Change coaching</SectionTitle>
      <Card className="px-4 py-3 flex flex-col gap-3">
        <div>
          <p className="text-sm">
            <span className="font-medium">Switch coach.</span> You can request another coach while this one is active. When a new coach accepts, your coaching with {name} ends
            automatically: you have one primary coach at a time.
          </p>
          <Button className="mt-2" icon={<Repeat className="size-4" />} onClick={() => nav('/coaching/find')}>
            Find another coach
          </Button>
        </div>
        <div className="border-t border-line pt-3">
          <Button variant="danger" icon={<UserX className="size-4" />} onClick={() => setEnding(true)}>
            End coaching
          </Button>
        </div>
      </Card>

      <ConfirmDialog
        open={ending}
        title={`End coaching with ${name}?`}
        danger
        confirmLabel="End coaching"
        busy={busy}
        onCancel={() => setEnding(false)}
        onConfirm={end}
        body={
          <ul className="list-disc pl-4 flex flex-col gap-1.5">
            <li>Your workouts and every program you accepted stay yours.</li>
            <li>Your current plan stays active. You can keep following it, or take it over so you can edit it yourself.</li>
            <li>{name} immediately loses access to everything you shared.</li>
            <li>Your conversation stays readable, but no new messages can be sent.</li>
          </ul>
        }
      >
        <Textarea className="mt-3" label="Reason (optional, shared with your coach)" maxLength={500} value={endReason} onChange={(e) => setEndReason(e.target.value)} />
      </ConfirmDialog>
    </>
  );
}

function CheckInList({ data, error, reload, unit, coachName, shared }: { data?: CheckIn[]; error: string | null; reload: () => Promise<void>; unit: 'kg' | 'lb'; coachName: string; shared: boolean }) {
  return (
    <>
      {!shared && (
        <Notice tone="warn" className="mb-2">
          Check-in sharing is off, so {coachName} can’t see your check-ins. Turn on “Check-ins” above to share them.
        </Notice>
      )}
      {error && !data ? (
        <ErrorState title="Couldn’t load check-ins" message={error} onRetry={reload} />
      ) : !data ? (
        <Spinner label="Loading check-ins" />
      ) : data.length === 0 ? (
        <Card className="px-4 py-3 text-sm text-muted">No check-ins yet. A quick check-in helps your coach adjust your plan.</Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {[...data]
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, 8)
            .map((c) => (
              <Card as="li" key={c.id} className="px-4 py-3">
                <p className="text-xs text-muted mb-2">{fmtDateTime(c.createdAt)}</p>
                <CheckInAnswers c={c} unit={unit} />
                {c.coachResponse ? (
                  <div className="mt-3 rounded-xl bg-accent-soft px-3 py-2 text-sm">
                    <p className="text-xs font-medium text-accent mb-0.5">{coachName} replied</p>
                    <p className="whitespace-pre-wrap break-words">{c.coachResponse}</p>
                  </div>
                ) : (
                  <p className="text-xs text-faint mt-2">No reply yet.</p>
                )}
              </Card>
            ))}
        </ul>
      )}
    </>
  );
}

function FeedbackList({ data, error, reload, sessionName }: { data?: CoachFeedback[]; error: string | null; reload: () => Promise<void>; sessionName: (id?: string | null) => string }) {
  if (error && !data) return <ErrorState title="Couldn’t load feedback" message={error} onRetry={reload} />;
  if (!data) return <Spinner label="Loading feedback" />;
  if (!data.length) return <Card className="px-4 py-3 text-sm text-muted">No feedback yet. Your coach can comment on workouts you share. They can never change what you logged.</Card>;
  return (
    <ul className="flex flex-col gap-2">
      {[...data]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 10)
        .map((f) => (
          <Card as="li" key={f.id} className="px-4 py-3">
            <p className="text-xs text-muted">
              {f.sessionId ? (
                <Link className="underline" to={`/train/history/${f.sessionId}`}>
                  {sessionName(f.sessionId)}
                </Link>
              ) : (
                sessionName(null)
              )}{' '}
              · {fmtDateTime(f.createdAt)}
            </p>
            <p className="text-sm mt-1 whitespace-pre-wrap break-words">{f.body}</p>
          </Card>
        ))}
    </ul>
  );
}

/* ================================================================ pending request */
function PendingRequest({ rel, onChanged }: { rel: CoachingRelationship; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const name = rel.coach.displayName || 'The coach';
  const cancel = async () => {
    setBusy(true);
    try {
      await coachingApi.cancelRequest(rel.id);
      setConfirm(false);
      toast.show('Request cancelled', { tone: 'success' });
      await onChanged();
    } catch (e) {
      toast.show(coachingError(e, 'Couldn’t cancel the request.'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="px-4 py-4 mt-3">
      <div className="flex items-center gap-3">
        <Avatar profile={{ displayName: name, username: '', avatarUrl: rel.coach.photoUrl }} size={44} />
        <div className="min-w-0 flex-1">
          <p className="font-semibold truncate">{name}</p>
          <p className="text-xs text-muted">Requested {fmtDateTime(rel.requestedAt)}</p>
        </div>
        <Badge tone="info">Waiting</Badge>
      </div>
      <p className="text-sm text-muted mt-3">
        Waiting for {name} to respond. Until they accept, they see only your intake and intro message. None of your records. Chat starts once they accept.
      </p>
      {rel.coach.suspended && <Notice tone="warn" className="mt-2">This coach’s account is currently suspended, so they can’t respond right now.</Notice>}
      <details className="mt-3">
        <summary className="cursor-pointer text-sm font-medium min-h-11 flex items-center">What you’ll share once accepted</summary>
        <div className="mt-2">
          <ScopeEditor
            scopes={rel.scopes}
            onSave={async (s) => {
              await coachingApi.setScopes(rel.id, s);
              await onChanged();
            }}
          />
        </div>
      </details>
      <Button className="mt-3" variant="ghost" onClick={() => setConfirm(true)}>
        Cancel request
      </Button>
      <ConfirmDialog
        open={confirm}
        title="Cancel this request?"
        body={`${name} won’t be able to accept it. You can send a new request later.`}
        confirmLabel="Cancel request"
        danger
        busy={busy}
        onCancel={() => setConfirm(false)}
        onConfirm={cancel}
      />
    </Card>
  );
}

/* ================================================================ take over */
/** After coaching ends, a coach-managed plan stays active; offer the explicit switch to self-managed. */
function TakeOverNotice({ activeRelationshipIds, ready }: { activeRelationshipIds: string[]; ready: boolean }) {
  const { db } = useApp();
  const toast = useToast();
  const nav = useNavigate();
  const programs = useLiveQuery(() => db.programs.toArray(), [db]);
  const [busy, setBusy] = useState(false);
  const plan = alive(programs ?? []).find((p) => p.active && p.managedBy?.kind === 'coach');
  if (!ready || !plan || (plan.managedBy?.relationshipId && activeRelationshipIds.includes(plan.managedBy.relationshipId))) return null;
  const take = async () => {
    setBusy(true);
    try {
      await saveRecord('programs', takeOverPlan(plan), db);
      toast.show('The plan is now yours to edit.', { tone: 'success', action: { label: 'Open', onClick: () => nav('/train/program') } });
    } catch (e) {
      toast.show(e instanceof Error ? e.message : 'Couldn’t update the plan.', { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Notice tone="accent" className="mb-3">
      <p>
        Your plan “{plan.name}” was written by {plan.managedBy?.coachName ?? 'your coach'}, and coaching has ended. It stays active: keep following it as it is, or take it
        over so you can edit it yourself. Completed workouts don’t change either way.
      </p>
      <Button size="sm" variant="primary" className="mt-2" loading={busy} onClick={take}>
        Take over the plan
      </Button>
    </Notice>
  );
}
