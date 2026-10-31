/**
 * /coaching/client/:relationshipId — the coach's view of one client. Every panel respects the client's
 * sharing choices (the server returns null for panels that aren't permitted). Coaches can add feedback
 * on sessions and answer check-ins but can never edit what the client logged.
 */
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { CalendarRange, MessageCircle, MessageSquarePlus, UserX } from 'lucide-react';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, ListRow, Notice, Page, SectionTitle, Sheet, Spinner, Stat, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import { coachingApi } from '@/backend/coaching';
import type { CheckIn, CoachFeedback, CoachingRelationship } from '@/backend/coachingContract';
import { formatCircumference, formatWeight } from '@/domain/units';
import { formatDate } from '@/lib/dates';
import { uuid } from '@/lib/id';
import { coachingError } from '@/coaching/errors';
import { RELATIONSHIP_STATUS_LABEL, SCOPE_INFO, SCOPE_KEYS } from '@/coaching/relationship';
import { Avatar } from '@/features/social/common';
import { BackButton, CheckInAnswers, CoachingAccessNotice, IntakeSummary, Panel, ProposalStatusBadge, fmtDateTime, useCoachingAccess, useLoad, useScrollToHash } from './tools/common';
import { CoachGate, TrainingSummary, useCoachStatus } from './tools/coach';

export default function ClientDetailPage() {
  const { relationshipId = '' } = useParams();
  const nav = useNavigate();
  const { access } = useCoachingAccess();
  const ok = access === 'ok';
  const coach = useCoachStatus(ok);
  const approved = coach.state === 'approved';
  const relQ = useLoad(async () => (await coachingApi.myRelationships()).find((r) => r.id === relationshipId && r.viewerIsCoach) ?? null, [relationshipId], ok && approved);
  const rel = relQ.data;

  return (
    <Page title={rel?.client.displayName || 'Client'} back={<BackButton to="/coaching/dashboard" />}>
      {!ok ? (
        <CoachingAccessNotice access={access} what="Client details" />
      ) : !approved ? (
        <CoachGate state={coach.state} profile={coach.profile} error={coach.error} reload={coach.reload} />
      ) : relQ.error && rel === undefined ? (
        <ErrorState title="Couldn’t load this client" message={relQ.error} onRetry={relQ.reload} />
      ) : rel === undefined ? (
        <Spinner label="Loading client" />
      ) : rel === null ? (
        <EmptyState title="Client not found" body="This coaching relationship doesn’t exist or isn’t yours." action={<Button onClick={() => nav('/coaching/dashboard')}>Dashboard</Button>} />
      ) : (
        <ClientBody rel={rel} reloadRel={relQ.reload} />
      )}
    </Page>
  );
}

function ClientBody({ rel, reloadRel }: { rel: CoachingRelationship; reloadRel: () => Promise<void> }) {
  const nav = useNavigate();
  const toast = useToast();
  const { account } = useApp();
  const unit = account.settings.units.weight;
  const lengthUnit = account.settings.units.length;
  const who = rel.client.displayName || 'your client';
  const isActive = rel.status === 'active';
  const overview = useLoad(() => coachingApi.clientOverview(rel.id), [rel.id], isActive, 'Couldn’t load this client’s records.');
  const proposals = useLoad(() => coachingApi.listProposals({ relationshipId: rel.id }), [rel.id], rel.status !== 'requested');
  const feedback = useLoad(() => coachingApi.listFeedback(rel.id), [rel.id], isActive);
  const [fbFor, setFbFor] = useState<{ sessionId: string | null; label: string } | null>(null);
  const [respondTo, setRespondTo] = useState<CheckIn | null>(null);
  const [ending, setEnding] = useState(false);
  const [endBusy, setEndBusy] = useState(false);
  const [endReason, setEndReason] = useState('');

  const ov = overview.data;
  useScrollToHash(!!ov);
  const t = ov?.training;
  const fbBySession = new Map<string, CoachFeedback[]>();
  for (const f of feedback.data ?? []) {
    const k = f.sessionId ?? '';
    fbBySession.set(k, [...(fbBySession.get(k) ?? []), f]);
  }

  const end = async () => {
    setEndBusy(true);
    try {
      await coachingApi.endCoaching(rel.id, endReason.trim() || undefined);
      setEnding(false);
      toast.show(`Coaching with ${who} has ended.`, { tone: 'success' });
      await reloadRel();
    } catch (e) {
      toast.show(coachingError(e, 'Couldn’t end coaching.'), { tone: 'error' });
    } finally {
      setEndBusy(false);
    }
  };

  return (
    <>
      <Card className="px-4 py-4">
        <div className="flex items-center gap-3">
          <Avatar profile={{ displayName: who, username: '', avatarUrl: rel.client.avatarUrl }} size={52} />
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold truncate">{who}</h2>
            <p className="text-sm text-muted">
              {RELATIONSHIP_STATUS_LABEL[rel.status]}
              {rel.respondedAt && rel.status === 'active' ? ` · coaching since ${fmtDateTime(rel.respondedAt)}` : ''}
              {rel.endedAt ? ` · ended ${fmtDateTime(rel.endedAt)}` : ''}
            </p>
          </div>
        </div>
        <div className="flex gap-2 mt-3 flex-wrap">
          {rel.status !== 'requested' && (
            <Button variant={isActive ? 'primary' : 'secondary'} icon={<MessageCircle className="size-4" />} onClick={() => nav(`/coaching/messages/${rel.id}`)}>
              {isActive ? 'Message' : 'Conversation history'}
              {rel.unread > 0 ? ` (${rel.unread})` : ''}
            </Button>
          )}
          {isActive && (
            <Button icon={<CalendarRange className="size-4" />} onClick={() => nav(`/coaching/client/${rel.id}/program`)}>
              {t?.activeProgram ? 'Revise program' : 'Build program'}
            </Button>
          )}
        </div>
        {isActive && (
          <div className="mt-3 flex flex-wrap gap-1.5" aria-label="What this client shares with you">
            {SCOPE_KEYS.map((k) => (
              <Badge key={k} tone={rel.scopes[k] ? 'accent' : 'neutral'}>
                {SCOPE_INFO[k].label}: {rel.scopes[k] ? 'shared' : 'not shared'}
              </Badge>
            ))}
          </div>
        )}
      </Card>

      {rel.status === 'requested' && (
        <Notice className="mt-3">
          This is a pending request. You see only the intake and intro message.{' '}
          <button type="button" className="underline font-medium" onClick={() => nav('/coaching/dashboard')}>
            Respond from your dashboard
          </button>
          .
        </Notice>
      )}
      {!isActive && rel.status !== 'requested' && <Notice className="mt-3">Coaching isn’t active, so this client’s records are no longer available to you.</Notice>}

      <SectionTitle>Intake & goals</SectionTitle>
      <Card className="px-4 py-3">
        <IntakeSummary intake={rel.intake} intro={rel.introMessage} />
      </Card>

      {isActive && (
        <>
          {overview.error && !ov && <ErrorState title="Couldn’t load records" message={overview.error} onRetry={overview.reload} />}
          {!ov && !overview.error && <Spinner label="Loading records" />}
          {ov && (
            <>
              <SectionTitle>Training</SectionTitle>
              <Panel value={t} who={who} what="Training history, adherence and the current program">
                {(tr) => (
                  <div className="flex flex-col gap-3">
                    <Card className="px-4 py-3">
                      {tr.activeProgram ? (
                        <>
                          <p className="font-medium">{tr.activeProgram.name}</p>
                          <p className="text-sm text-muted">
                            Version {tr.activeProgram.currentVersion} · managed by{' '}
                            {tr.activeProgram.managedBy === 'coach' ? 'a coach' : tr.activeProgram.managedBy === 'ai' ? 'the training assistant' : who}
                          </p>
                        </>
                      ) : (
                        <p className="text-sm text-muted">No active program.</p>
                      )}
                      <div className="grid grid-cols-2 gap-3 mt-3">
                        <Stat label="Completed (28 days)" value={tr.completedLast28} />
                        <Stat label="Planned (28 days)" value={tr.plannedLast28 ?? '–'} />
                      </div>
                      <div className="mt-2">
                        <TrainingSummary training={tr} who={who} />
                      </div>
                    </Card>
                    <Card className="overflow-hidden">
                      <h3 className="px-4 pt-3 text-sm font-semibold">Recent sessions</h3>
                      {tr.recentSessions.length === 0 ? (
                        <p className="px-4 py-3 text-sm text-muted">No sessions logged recently.</p>
                      ) : (
                        <ul className="divide-y divide-line">
                          {tr.recentSessions.map((s) => (
                            <li key={s.id} className="px-4 py-3">
                              <div className="flex items-start gap-2">
                                <div className="min-w-0 flex-1">
                                  <p className="font-medium truncate">{s.name}</p>
                                  <p className="text-xs text-muted">
                                    {formatDate(s.date)} · {s.status === 'completed' ? 'Completed' : s.status === 'active' ? 'In progress' : s.status}
                                    {s.durationMin ? ` · ${s.durationMin} min` : ''} · {s.workingSets} working sets
                                  </p>
                                </div>
                                <Button size="sm" variant="ghost" icon={<MessageSquarePlus className="size-4" />} onClick={() => setFbFor({ sessionId: s.id, label: `${s.name} · ${formatDate(s.date)}` })}>
                                  Feedback
                                </Button>
                              </div>
                              {(fbBySession.get(s.id) ?? []).map((f) => (
                                <p key={f.id} className="mt-2 rounded-xl bg-surface-2 px-3 py-2 text-sm whitespace-pre-wrap break-words">
                                  {f.body} <span className="block text-[11px] text-faint mt-0.5">{fmtDateTime(f.createdAt)}</span>
                                </p>
                              ))}
                            </li>
                          ))}
                        </ul>
                      )}
                      <p className="px-4 pb-3 text-xs text-muted">You can comment on sessions; you can’t change what {who} logged.</p>
                    </Card>
                  </div>
                )}
              </Panel>

              <SectionTitle>Measurements</SectionTitle>
              <Panel value={ov.measurements} who={who} what="Bodyweight and body measurements">
                {(ms) =>
                  ms.length === 0 ? (
                    <Card className="px-4 py-3 text-sm text-muted">No measurements logged.</Card>
                  ) : (
                    <Card className="overflow-hidden">
                      <ul className="divide-y divide-line">
                        {[...ms]
                          .sort((a, b) => b.date.localeCompare(a.date))
                          .slice(0, 12)
                          .map((m, i) => (
                            <li key={`${m.date}-${m.kind}-${i}`}>
                              <ListRow
                                title={m.kind === 'bodyweight' ? 'Bodyweight' : m.kind === 'bodyfat_pct' ? 'Body fat' : m.kind.charAt(0).toUpperCase() + m.kind.slice(1)}
                                subtitle={formatDate(m.date)}
                                right={<span className="tabular text-ink">{m.kind === 'bodyweight' ? formatWeight(m.value, unit) : m.kind === 'bodyfat_pct' ? `${m.value}%` : formatCircumference(m.value, lengthUnit)}</span>}
                              />
                            </li>
                          ))}
                      </ul>
                    </Card>
                  )
                }
              </Panel>

              <SectionTitle>Nutrition</SectionTitle>
              <Panel value={ov.nutrition} who={who} what="Food log totals">
                {(ns) =>
                  ns.length === 0 ? (
                    <Card className="px-4 py-3 text-sm text-muted">No food logged recently.</Card>
                  ) : (
                    <Card className="overflow-hidden">
                      <ul className="divide-y divide-line">
                        {[...ns]
                          .sort((a, b) => b.date.localeCompare(a.date))
                          .slice(0, 14)
                          .map((n) => (
                            <li key={n.date}>
                              <ListRow
                                title={formatDate(n.date)}
                                right={
                                  <span className="tabular text-ink text-sm">
                                    {n.protein != null ? `${Math.round(n.protein)} g protein` : '–'}
                                    {n.kcal != null ? ` · ${Math.round(n.kcal)} kcal` : ''}
                                  </span>
                                }
                              />
                            </li>
                          ))}
                      </ul>
                    </Card>
                  )
                }
              </Panel>

              <SectionTitle id="checkins">Check-ins</SectionTitle>
              <Panel value={ov.checkins} who={who} what="Check-ins">
                {(cs) =>
                  cs.length === 0 ? (
                    <Card className="px-4 py-3 text-sm text-muted">No check-ins yet.</Card>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {[...cs]
                        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                        .map((c) => (
                          <Card as="li" key={c.id} className="px-4 py-3">
                            <p className="text-xs text-muted mb-2">{fmtDateTime(c.createdAt)}</p>
                            <CheckInAnswers c={c} unit={unit} />
                            {c.coachResponse ? (
                              <p className="mt-3 rounded-xl bg-accent-soft px-3 py-2 text-sm whitespace-pre-wrap break-words">
                                <span className="block text-xs font-medium text-accent">Your reply</span>
                                {c.coachResponse}
                              </p>
                            ) : (
                              <Button size="sm" className="mt-3" onClick={() => setRespondTo(c)}>
                                Reply
                              </Button>
                            )}
                          </Card>
                        ))}
                    </ul>
                  )
                }
              </Panel>

              <div className="mt-3">
                <Button variant="ghost" icon={<MessageSquarePlus className="size-4" />} onClick={() => setFbFor({ sessionId: null, label: 'General feedback' })}>
                  Send general feedback
                </Button>
                {(fbBySession.get('') ?? []).map((f) => (
                  <p key={f.id} className="mt-2 rounded-xl bg-surface-2 px-3 py-2 text-sm whitespace-pre-wrap break-words">
                    {f.body} <span className="block text-[11px] text-faint mt-0.5">{fmtDateTime(f.createdAt)}</span>
                  </p>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {rel.status !== 'requested' && (
        <>
          <SectionTitle>Program proposals</SectionTitle>
          {proposals.error && !proposals.data ? (
            <ErrorState title="Couldn’t load proposals" message={proposals.error} onRetry={proposals.reload} />
          ) : !proposals.data ? (
            <Spinner label="Loading proposals" />
          ) : proposals.data.length === 0 ? (
            <Card className="px-4 py-3 text-sm text-muted">No proposals yet.</Card>
          ) : (
            <Card className="overflow-hidden">
              <ul className="divide-y divide-line">
                {[...proposals.data]
                  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                  .map((p) => (
                    <li key={p.id}>
                      <ListRow
                        title={p.program.name}
                        subtitle={`Revision ${p.revision} · ${p.baseProgramId ? `update to v${p.baseVersion}` : 'new plan'} · ${fmtDateTime(p.respondedAt ?? p.sentAt ?? p.createdAt)}`}
                        right={<ProposalStatusBadge status={p.status} />}
                        onClick={isActive ? () => nav(`/coaching/client/${rel.id}/program?proposal=${p.id}`) : undefined}
                      />
                    </li>
                  ))}
              </ul>
            </Card>
          )}
        </>
      )}

      {isActive && (
        <div className="mt-6">
          <Button variant="danger" icon={<UserX className="size-4" />} onClick={() => setEnding(true)}>
            End coaching
          </Button>
        </div>
      )}

      <FeedbackSheet target={fbFor} relationshipId={rel.id} onClose={() => setFbFor(null)} onSaved={feedback.reload} />
      <RespondSheet checkin={respondTo} who={who} onClose={() => setRespondTo(null)} onSaved={overview.reload} />
      <ConfirmDialog
        open={ending}
        title={`End coaching with ${who}?`}
        danger
        confirmLabel="End coaching"
        busy={endBusy}
        onCancel={() => setEnding(false)}
        onConfirm={end}
        body={`You immediately lose access to ${who}’s shared records. Their workouts and accepted programs stay theirs, and your conversation stays readable but closed to new messages.`}
      >
        <Textarea className="mt-3" label="Reason (optional, shared with the client)" maxLength={500} value={endReason} onChange={(e) => setEndReason(e.target.value)} />
      </ConfirmDialog>
    </>
  );
}

function FeedbackSheet({ target, relationshipId, onClose, onSaved }: { target: { sessionId: string | null; label: string } | null; relationshipId: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [body, setBody] = useState('');
  const [id, setId] = useState(() => uuid());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setError(null);
    onClose();
  };
  const save = async () => {
    if (!target || !body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await coachingApi.addFeedback({ id, relationshipId, sessionId: target.sessionId, body: body.trim() });
      toast.show('Feedback sent', { tone: 'success' });
      setBody('');
      setId(uuid());
      onClose();
      await onSaved();
    } catch (e) {
      setError(coachingError(e, 'Your feedback wasn’t sent. Try again.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={!!target}
      onClose={close}
      title={target?.label ?? 'Feedback'}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!body.trim()} onClick={save}>
            Send feedback
          </Button>
        </>
      }
    >
      <Textarea label="Feedback" maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} error={error} hint="The client sees this with the workout. Their logged results stay exactly as they recorded them." />
    </Sheet>
  );
}

function RespondSheet({ checkin, who, onClose, onSaved }: { checkin: CheckIn | null; who: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const { account } = useApp();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (!checkin || !body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await coachingApi.respondCheckIn(checkin.id, body.trim());
      toast.show('Reply sent', { tone: 'success' });
      setBody('');
      onClose();
      await onSaved();
    } catch (e) {
      setError(coachingError(e, 'Your reply wasn’t sent. Try again.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={!!checkin}
      onClose={onClose}
      title={`Reply to ${who}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!body.trim()} onClick={save}>
            Send reply
          </Button>
        </>
      }
    >
      {checkin && (
        <div className="mb-3">
          <CheckInAnswers c={checkin} unit={account.settings.units.weight} />
        </div>
      )}
      <Textarea label="Your reply" maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} error={error} />
    </Sheet>
  );
}
