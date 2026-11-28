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
import { programDisplayName } from '@/domain/program/localize';
import { t as tNow, tKey, useT } from '@/i18n';
import { workoutDisplayName } from '@/features/program/parts';

export default function ClientDetailPage() {
  const { relationshipId = '' } = useParams();
  const nav = useNavigate();
  const { t } = useT();
  const { access } = useCoachingAccess();
  const ok = access === 'ok';
  const coach = useCoachStatus(ok);
  const approved = coach.state === 'approved';
  const relQ = useLoad(async () => (await coachingApi.myRelationships()).find((r) => r.id === relationshipId && r.viewerIsCoach) ?? null, [relationshipId], ok && approved);
  const rel = relQ.data;

  return (
    <Page title={rel?.client.displayName || t('coaching.client.client')} back={<BackButton to="/coaching/dashboard" />}>
      {!ok ? (
        <CoachingAccessNotice access={access} what={t('coaching.client.what_client_details')} />
      ) : !approved ? (
        <CoachGate state={coach.state} profile={coach.profile} error={coach.error} reload={coach.reload} />
      ) : relQ.error && rel === undefined ? (
        <ErrorState title={t('coaching.client.couldnt_load_this_client')} message={relQ.error} onRetry={relQ.reload} />
      ) : rel === undefined ? (
        <Spinner label={t('coaching.client.loading_client')} />
      ) : rel === null ? (
        <EmptyState
          title={t('coaching.client.client_not_found')}
          body={t('coaching.client.this_coaching_relationship_doesnt_exist_or')}
          action={<Button onClick={() => nav('/coaching/dashboard')}>{t('coaching.client.dashboard')}</Button>}
        />
      ) : (
        <ClientBody rel={rel} reloadRel={relQ.reload} />
      )}
    </Page>
  );
}

function ClientBody({ rel, reloadRel }: { rel: CoachingRelationship; reloadRel: () => Promise<void> }) {
  const nav = useNavigate();
  const toast = useToast();
  const { t, tp } = useT();
  const { account } = useApp();
  const unit = account.settings.units.weight;
  const lengthUnit = account.settings.units.length;
  const who = rel.client.displayName || t('coaching.client.your_client');
  const isActive = rel.status === 'active';
  const overview = useLoad(() => coachingApi.clientOverview(rel.id), [rel.id], isActive, tNow('coaching.client.couldnt_load_this_clients_records'));
  const proposals = useLoad(() => coachingApi.listProposals({ relationshipId: rel.id }), [rel.id], rel.status !== 'requested');
  const feedback = useLoad(() => coachingApi.listFeedback(rel.id), [rel.id], isActive);
  const [fbFor, setFbFor] = useState<{ sessionId: string | null; label: string } | null>(null);
  const [respondTo, setRespondTo] = useState<CheckIn | null>(null);
  const [ending, setEnding] = useState(false);
  const [endBusy, setEndBusy] = useState(false);
  const [endReason, setEndReason] = useState('');

  const ov = overview.data;
  useScrollToHash(!!ov);
  const training = ov?.training;
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
      toast.show(t('coaching.client.coaching_with_x_has_ended', { name: who }), { tone: 'success' });
      await reloadRel();
    } catch (e) {
      toast.show(coachingError(e, t('coaching.client.couldnt_end_coaching')), { tone: 'error' });
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
              {[
                RELATIONSHIP_STATUS_LABEL[rel.status],
                rel.respondedAt && rel.status === 'active' ? t('coaching.client.coaching_since_x', { date: fmtDateTime(rel.respondedAt) }) : null,
                rel.endedAt ? t('coaching.client.ended_x', { date: fmtDateTime(rel.endedAt) }) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
        </div>
        <div className="flex gap-2 mt-3 flex-wrap">
          {rel.status !== 'requested' && (
            <Button variant={isActive ? 'primary' : 'secondary'} icon={<MessageCircle className="size-4" />} onClick={() => nav(`/coaching/messages/${rel.id}`)}>
              {isActive ? t('coaching.messages.message') : t('coaching.client.conversation_history')}
              {rel.unread > 0 ? ` (${rel.unread})` : ''}
            </Button>
          )}
          {isActive && (
            <Button icon={<CalendarRange className="size-4" />} onClick={() => nav(`/coaching/client/${rel.id}/program`)}>
              {training?.activeProgram ? t('coaching.client.revise_program') : t('coaching.client.build_program')}
            </Button>
          )}
        </div>
        {isActive && (
          <div className="mt-3 flex flex-wrap gap-1.5" aria-label={t('coaching.client.what_this_client_shares_with_you')}>
            {SCOPE_KEYS.map((k) => (
              <Badge key={k} tone={rel.scopes[k] ? 'accent' : 'neutral'}>
                {SCOPE_INFO[k].label}: {rel.scopes[k] ? t('coaching.client.shared') : t('coaching.client.not_shared')}
              </Badge>
            ))}
          </div>
        )}
      </Card>

      {rel.status === 'requested' && (
        <Notice className="mt-3">
          {t('coaching.client.this_is_a_pending_request_you')}{' '}
          <button type="button" className="underline font-medium" onClick={() => nav('/coaching/dashboard')}>
            {t('coaching.client.respond_from_your_dashboard')}
          </button>
          .
        </Notice>
      )}
      {!isActive && rel.status !== 'requested' && <Notice className="mt-3">{t('coaching.client.coaching_isnt_active_so_this_clients')}</Notice>}

      <SectionTitle>{t('coaching.client.intake_goals')}</SectionTitle>
      <Card className="px-4 py-3">
        <IntakeSummary intake={rel.intake} intro={rel.introMessage} />
      </Card>

      {isActive && (
        <>
          {overview.error && !ov && <ErrorState title={t('coaching.client.couldnt_load_records')} message={overview.error} onRetry={overview.reload} />}
          {!ov && !overview.error && <Spinner label={t('coaching.client.loading_records')} />}
          {ov && (
            <>
              <SectionTitle>{t('ai.scope.training')}</SectionTitle>
              <Panel value={training} who={who} what={t('coaching.client.what_training')}>
                {(tr) => (
                  <div className="flex flex-col gap-3">
                    <Card className="px-4 py-3">
                      {tr.activeProgram ? (
                        <>
                          <p className="font-medium">{programDisplayName(tr.activeProgram.name)}</p>
                          <p className="text-sm text-muted">
                            {t('coaching.client.managed_by', {
                              version: tr.activeProgram.currentVersion,
                              manager: tr.activeProgram.managedBy === 'coach' ? t('coaching.client.a_coach') : tr.activeProgram.managedBy === 'ai' ? t('coaching.client.the_training_assistant') : who,
                            })}
                          </p>
                        </>
                      ) : (
                        <p className="text-sm text-muted">{t('progress.noProgram')}</p>
                      )}
                      <div className="grid grid-cols-2 gap-3 mt-3">
                        <Stat label={t('coaching.client.completed_28_days')} value={tr.completedLast28} />
                        <Stat label={t('coaching.client.planned_28_days')} value={tr.plannedLast28 ?? '–'} />
                      </div>
                      <div className="mt-2">
                        <TrainingSummary training={tr} who={who} />
                      </div>
                    </Card>
                    <Card className="overflow-hidden">
                      <h3 className="px-4 pt-3 text-sm font-semibold">{t('coaching.client.recent_sessions')}</h3>
                      {tr.recentSessions.length === 0 ? (
                        <p className="px-4 py-3 text-sm text-muted">{t('coaching.client.no_sessions_logged_recently')}</p>
                      ) : (
                        <ul className="divide-y divide-line">
                          {tr.recentSessions.map((s) => (
                            <li key={s.id} className="px-4 py-3">
                              <div className="flex items-start gap-2">
                                <div className="min-w-0 flex-1">
                                  <p className="font-medium truncate">{workoutDisplayName(s)}</p>
                                  <p className="text-xs text-muted">
                                    {[
                                      formatDate(s.date),
                                      s.status === 'completed' ? t('coaching.client.completed') : s.status === 'active' ? t('train.inProgress') : s.status,
                                      s.durationMin ? t('coaching.client.x_min', { minutes: s.durationMin }) : null,
                                      tp('coaching.client.working_sets_count', s.workingSets),
                                    ]
                                      .filter(Boolean)
                                      .join(' · ')}
                                  </p>
                                </div>
                                <Button size="sm" variant="ghost" icon={<MessageSquarePlus className="size-4" />} onClick={() => setFbFor({ sessionId: s.id, label: `${workoutDisplayName(s)} · ${formatDate(s.date)}` })}>
                                  {t('coaching.client.feedback')}
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
                      <p className="px-4 pb-3 text-xs text-muted">{t('coaching.client.you_can_comment_on_sessions_you', { name: who })}</p>
                    </Card>
                  </div>
                )}
              </Panel>

              <SectionTitle>{t('ai.scope.measurements')}</SectionTitle>
              <Panel value={ov.measurements} who={who} what={t('coaching.client.what_measurements')}>
                {(ms) =>
                  ms.length === 0 ? (
                    <Card className="px-4 py-3 text-sm text-muted">{t('coaching.client.no_measurements_logged')}</Card>
                  ) : (
                    <Card className="overflow-hidden">
                      <ul className="divide-y divide-line">
                        {[...ms]
                          .sort((a, b) => b.date.localeCompare(a.date))
                          .slice(0, 12)
                          .map((m, i) => (
                            <li key={`${m.date}-${m.kind}-${i}`}>
                              <ListRow
                                title={m.kind === 'bodyfat_pct' ? t('progress.bodyFat') : tKey(`progress.${m.kind}`, m.kind.charAt(0).toUpperCase() + m.kind.slice(1))}
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

              <SectionTitle>{t('today.nutrition')}</SectionTitle>
              <Panel value={ov.nutrition} who={who} what={t('coaching.client.what_nutrition')}>
                {(ns) =>
                  ns.length === 0 ? (
                    <Card className="px-4 py-3 text-sm text-muted">{t('coaching.client.no_food_logged_recently')}</Card>
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
                                    {[n.protein != null ? t('coaching.client.x_g_protein', { grams: Math.round(n.protein) }) : '–', n.kcal != null ? t('coaching.client.x_kcal', { kcal: Math.round(n.kcal) }) : null]
                                      .filter(Boolean)
                                      .join(' · ')}
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

              <SectionTitle id="checkins">{t('coaching.shareScope.check_ins')}</SectionTitle>
              <Panel value={ov.checkins} who={who} what={t('coaching.shareScope.check_ins')}>
                {(cs) =>
                  cs.length === 0 ? (
                    <Card className="px-4 py-3 text-sm text-muted">{t('coaching.client.no_check_ins_yet')}</Card>
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
                                <span className="block text-xs font-medium text-accent">{t('coaching.client.your_reply')}</span>
                                {c.coachResponse}
                              </p>
                            ) : (
                              <Button size="sm" className="mt-3" onClick={() => setRespondTo(c)}>
                                {t('coaching.client.reply')}
                              </Button>
                            )}
                          </Card>
                        ))}
                    </ul>
                  )
                }
              </Panel>

              <div className="mt-3">
                <Button variant="ghost" icon={<MessageSquarePlus className="size-4" />} onClick={() => setFbFor({ sessionId: null, label: t('coaching.client.general_feedback') })}>
                  {t('coaching.client.send_general_feedback')}
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
          <SectionTitle>{t('coaching.client.program_proposals')}</SectionTitle>
          {proposals.error && !proposals.data ? (
            <ErrorState title={t('coaching.client.couldnt_load_proposals')} message={proposals.error} onRetry={proposals.reload} />
          ) : !proposals.data ? (
            <Spinner label={t('coaching.client.loading_proposals')} />
          ) : proposals.data.length === 0 ? (
            <Card className="px-4 py-3 text-sm text-muted">{t('coaching.client.no_proposals_yet')}</Card>
          ) : (
            <Card className="overflow-hidden">
              <ul className="divide-y divide-line">
                {[...proposals.data]
                  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                  .map((p) => (
                    <li key={p.id}>
                      <ListRow
                        title={programDisplayName(p.program.name)}
                        subtitle={t('coaching.client.revision_x_x_x', {
                          revision: p.revision,
                          kind: p.baseProgramId ? t('coaching.client.update_to_vx', { version: p.baseVersion ?? '' }) : t('coaching.client.new_plan_lower'),
                          date: fmtDateTime(p.respondedAt ?? p.sentAt ?? p.createdAt),
                        })}
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
            {t('coaching.client.end_coaching')}
          </Button>
        </div>
      )}

      <FeedbackSheet target={fbFor} relationshipId={rel.id} onClose={() => setFbFor(null)} onSaved={feedback.reload} />
      <RespondSheet checkin={respondTo} who={who} onClose={() => setRespondTo(null)} onSaved={overview.reload} />
      <ConfirmDialog
        open={ending}
        title={t('coaching.client.end_coaching_with_x', { name: who })}
        danger
        confirmLabel={t('coaching.client.end_coaching')}
        busy={endBusy}
        onCancel={() => setEnding(false)}
        onConfirm={end}
        body={t('coaching.client.you_immediately_lose_access_to_xs', { name: who })}
      >
        <Textarea className="mt-3" label={t('coaching.client.reason_optional_shared_with_the_client')} maxLength={500} value={endReason} onChange={(e) => setEndReason(e.target.value)} />
      </ConfirmDialog>
    </>
  );
}

function FeedbackSheet({ target, relationshipId, onClose, onSaved }: { target: { sessionId: string | null; label: string } | null; relationshipId: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const { t } = useT();
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
      toast.show(t('coaching.client.feedback_sent'), { tone: 'success' });
      setBody('');
      setId(uuid());
      onClose();
      await onSaved();
    } catch (e) {
      setError(coachingError(e, t('coaching.client.feedback_not_sent')));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={!!target}
      onClose={close}
      title={target?.label ?? t('coaching.client.feedback')}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={busy} disabled={!body.trim()} onClick={save}>
            {t('coaching.client.send_feedback')}
          </Button>
        </>
      }
    >
      <Textarea label={t('coaching.client.feedback')} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} error={error} hint={t('coaching.client.the_client_sees_this_with_the')} />
    </Sheet>
  );
}

function RespondSheet({ checkin, who, onClose, onSaved }: { checkin: CheckIn | null; who: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const { t } = useT();
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
      toast.show(t('coaching.client.reply_sent'), { tone: 'success' });
      setBody('');
      onClose();
      await onSaved();
    } catch (e) {
      setError(coachingError(e, t('coaching.client.reply_not_sent')));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={!!checkin}
      onClose={onClose}
      title={t('coaching.client.reply_to_x', { name: who })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={busy} disabled={!body.trim()} onClick={save}>
            {t('coaching.client.send_reply')}
          </Button>
        </>
      }
    >
      {checkin && (
        <div className="mb-3">
          <CheckInAnswers c={checkin} unit={account.settings.units.weight} />
        </div>
      )}
      <Textarea label={t('coaching.client.your_reply')} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} error={error} />
    </Sheet>
  );
}
