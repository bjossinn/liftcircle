/**
 * /coaching/dashboard — coach home: pending requests (intake + intro only), active clients with unread
 * counts and permitted adherence, things needing attention, and reusable session templates
 * (the coach's own db.templates library) with "Duplicate for a client".
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check, CopyPlus, Inbox, Plus, Users, X } from 'lucide-react';
import { Badge, Button, Card, EmptyState, ErrorState, ListRow, Notice, Page, SectionTitle, Sheet, Spinner, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import { useExercises } from '@/data/catalog';
import { coachingApi } from '@/backend/coaching';
import type { ClientOverview, CoachingRelationship } from '@/backend/coachingContract';
import type { SavedTemplate } from '@/domain/types';
import { alive, deleteRecord, newRecord, saveRecord } from '@/db/repo';
import { emptyTemplate } from '@/domain/program/generator';
import { coachingError } from '@/coaching/errors';
import { SessionCard } from '@/features/program/parts';
import { Avatar } from '@/features/social/common';
import { BackButton, CoachingAccessNotice, IntakeSummary, ProposalStatusBadge, fmtDateTime, useCoachingAccess, useLoad } from './tools/common';
import { ClientCard, CoachGate, useCoachStatus } from './tools/coach';

type OverviewState = Record<string, { data?: ClientOverview; error?: string }>;

export default function CoachDashboardPage() {
  const nav = useNavigate();
  const { access } = useCoachingAccess();
  const ok = access === 'ok';
  const coach = useCoachStatus(ok);
  const approved = coach.state === 'approved';
  const rels = useLoad(async () => (await coachingApi.myRelationships()).filter((r) => r.viewerIsCoach), [], ok && approved);
  const proposals = useLoad(() => coachingApi.listProposals({ mine: true }), [], ok && approved);

  const pending = useMemo(() => (rels.data ?? []).filter((r) => r.status === 'requested').sort((a, b) => a.requestedAt.localeCompare(b.requestedAt)), [rels.data]);
  const active = useMemo(() => (rels.data ?? []).filter((r) => r.status === 'active').sort((a, b) => b.unread - a.unread || a.client.displayName.localeCompare(b.client.displayName)), [rels.data]);
  const activeKey = active.map((r) => r.id).join(',');

  const [overviews, setOverviews] = useState<OverviewState>({});
  useEffect(() => {
    if (!activeKey) return;
    let cancelled = false;
    const ids = activeKey.split(',');
    void Promise.allSettled(ids.map((id) => coachingApi.clientOverview(id))).then((res) => {
      if (cancelled) return;
      const next: OverviewState = {};
      res.forEach((r, i) => (next[ids[i]] = r.status === 'fulfilled' ? { data: r.value } : { error: coachingError(r.reason) }));
      setOverviews(next);
    });
    return () => {
      cancelled = true;
    };
  }, [activeKey]);

  const nameOf = (relId?: string | null) => rels.data?.find((r) => r.id === relId)?.client.displayName ?? 'Client';
  const checkinsToAnswer = active.flatMap((r) => (overviews[r.id]?.data?.checkins ?? []).filter((c) => !c.coachResponse).map((c) => ({ rel: r, c })));
  const latestPerRel = useMemo(() => {
    const m = new Map<string, NonNullable<typeof proposals.data>[number]>();
    for (const p of proposals.data ?? []) {
      if (!p.relationshipId) continue;
      const cur = m.get(p.relationshipId);
      if (!cur || p.createdAt > cur.createdAt) m.set(p.relationshipId, p);
    }
    return m;
  }, [proposals.data]);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const programAttention = [...latestPerRel.values()].filter(
    (p) => p.status === 'declined' || p.status === 'invalid' || p.status === 'draft' || (p.status === 'accepted' && (p.respondedAt ?? '') > weekAgo),
  );

  return (
    <Page title="Your coaching workspace" back={<BackButton to="/coaching" />}>
      {!ok ? (
        <CoachingAccessNotice access={access} what="The coach dashboard" />
      ) : !approved ? (
        <CoachGate state={coach.state} profile={coach.profile} error={coach.error} reload={coach.reload} />
      ) : rels.error && !rels.data ? (
        <ErrorState title="Couldn’t load your clients" message={rels.error} onRetry={rels.reload} />
      ) : !rels.data ? (
        <Spinner label="Loading your clients" />
      ) : (
        <>
          {coach.profile && (!coach.profile.listed || !coach.profile.acceptingClients) && (
            <Notice className="mb-3">
              {!coach.profile.listed ? 'Your listing is hidden from the directory.' : 'You’re not accepting new clients.'} Existing clients aren’t affected.
            </Notice>
          )}

          <SectionTitle>Requests ({pending.length})</SectionTitle>
          {pending.length === 0 ? (
            <Card className="px-4 py-3 text-sm text-muted">No pending requests.</Card>
          ) : (
            <ul className="flex flex-col gap-2">
              {pending.map((r) => (
                <RequestCard key={r.id} rel={r} onDone={rels.reload} />
              ))}
            </ul>
          )}

          <SectionTitle>Needs attention</SectionTitle>
          {checkinsToAnswer.length === 0 && programAttention.length === 0 ? (
            <Card className="px-4 py-3 text-sm text-muted">You’re all caught up.</Card>
          ) : (
            <Card className="overflow-hidden">
              <ul className="divide-y divide-line">
                {checkinsToAnswer.map(({ rel, c }) => (
                  <li key={c.id}>
                    <ListRow title={`${rel.client.displayName}: check-in`} subtitle={`Sent ${fmtDateTime(c.createdAt)} · waiting for your reply`} right={<Badge tone="warn">Reply</Badge>} onClick={() => nav(`/coaching/client/${rel.id}#checkins`)} />
                  </li>
                ))}
                {programAttention.map((p) => (
                  <li key={p.id}>
                    <ListRow
                      title={`${nameOf(p.relationshipId)}: ${p.program.name}`}
                      subtitle={
                        p.status === 'declined'
                          ? `Declined ${fmtDateTime(p.respondedAt)}: consider a revision`
                          : p.status === 'draft'
                            ? 'Draft not sent yet'
                            : p.status === 'invalid'
                              ? 'Didn’t pass validation'
                              : `Accepted ${fmtDateTime(p.respondedAt)}`
                      }
                      right={<ProposalStatusBadge status={p.status} />}
                      onClick={() => nav(`/coaching/client/${p.relationshipId}/program`)}
                    />
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <SectionTitle>Clients ({active.length})</SectionTitle>
          {active.length === 0 ? (
            <EmptyState icon={<Users className="size-6" aria-hidden />} title="Your clients will appear here once they’re connected." body="When you accept a request, the client appears here. Clients choose what they share with you." />
          ) : (
            <ul className="flex flex-col gap-2">
              {active.map((r) => (
                <ClientCard key={r.id} rel={r} overview={overviews[r.id]?.data} overviewError={overviews[r.id]?.error} />
              ))}
            </ul>
          )}

          <CoachTemplates clients={active} />
        </>
      )}
    </Page>
  );
}

/* ================================================================ requests */
function RequestCard({ rel, onDone }: { rel: CoachingRelationship; onDone: () => Promise<void> }) {
  const toast = useToast();
  const [mode, setMode] = useState<'accept' | 'decline' | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const name = rel.client.displayName || 'This person';
  const respond = async () => {
    if (!mode) return;
    setBusy(true);
    try {
      await coachingApi.respondRequest(rel.id, mode === 'accept', message.trim() || undefined);
      toast.show(mode === 'accept' ? `You’re now coaching ${name}.` : 'Request declined.', { tone: 'success' });
      setMode(null);
      setMessage('');
      await onDone();
    } catch (e) {
      toast.show(coachingError(e, 'Couldn’t respond to the request.'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card as="li" className="px-4 py-3">
      <div className="flex items-center gap-3 mb-3">
        <Avatar profile={{ displayName: name, username: '', avatarUrl: rel.client.avatarUrl }} size={40} />
        <div className="min-w-0 flex-1">
          <p className="font-semibold truncate">{name}</p>
          <p className="text-xs text-muted">Requested {fmtDateTime(rel.requestedAt)}</p>
        </div>
        <Inbox className="size-5 text-muted" aria-hidden />
      </div>
      <IntakeSummary intake={rel.intake} intro={rel.introMessage} />
      <p className="text-xs text-muted mt-3">Until you accept, you see only this intake and intro message. None of their records.</p>
      <div className="flex gap-2 mt-3">
        <Button variant="ghost" icon={<X className="size-4" />} onClick={() => setMode('decline')}>
          Decline
        </Button>
        <Button variant="primary" icon={<Check className="size-4" />} onClick={() => setMode('accept')}>
          Accept
        </Button>
      </div>
      <Sheet
        open={!!mode}
        onClose={() => setMode(null)}
        title={mode === 'accept' ? `Accept ${name}?` : `Decline ${name}’s request?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
            <Button variant={mode === 'accept' ? 'primary' : 'danger'} loading={busy} onClick={respond}>
              {mode === 'accept' ? 'Accept and start coaching' : 'Decline request'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted mb-3">
          {mode === 'accept'
            ? `Coaching starts now and a private conversation opens. You’ll see only what ${name} chose to share. If they have another coach, that coaching ends.`
            : `${name} will be told you declined. A short, kind reason helps them find the right coach.`}
        </p>
        <Textarea label="Message (optional)" maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} />
      </Sheet>
    </Card>
  );
}

/* ================================================================ templates */
function CoachTemplates({ clients }: { clients: CoachingRelationship[] }) {
  const nav = useNavigate();
  const toast = useToast();
  const { db, account } = useApp();
  const { list: catalog, byId } = useExercises();
  const rows = useLiveQuery(() => db.templates.toArray(), [db]);
  const templates = useMemo(() => alive(rows ?? []).sort((a, b) => a.template.name.localeCompare(b.template.name)), [rows]);
  const [dupFor, setDupFor] = useState<SavedTemplate | null>(null);

  const save = async (rec: SavedTemplate, template: SavedTemplate['template']) => {
    try {
      await saveRecord('templates', { ...rec, template }, db);
    } catch (e) {
      toast.show(e instanceof Error ? e.message : 'Couldn’t save the template.', { tone: 'error' });
    }
  };
  const create = async () => {
    try {
      await saveRecord('templates', newRecord({ template: emptyTemplate(`lib:${Date.now().toString(36)}`, 'New session template') }), db);
    } catch (e) {
      toast.show(e instanceof Error ? e.message : 'Couldn’t create the template.', { tone: 'error' });
    }
  };

  return (
    <section aria-labelledby="tpl-title">
      <SectionTitle
        id="tpl-title"
        action={
          <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={create}>
            New template
          </Button>
        }
      >
        Your session templates
      </SectionTitle>
      <p className="text-xs text-muted px-1 mb-2">Reusable sessions from your own template library. Edit them here, then duplicate one into a client’s program. The client gets a copy, never a link.</p>
      {rows === undefined ? (
        <Spinner label="Loading templates" />
      ) : templates.length === 0 ? (
        <Card className="px-4 py-3 text-sm text-muted">No templates yet. Create one, or save a session to your library from any program.</Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {templates.map((rec) => (
            <li key={rec.id} className="flex flex-col gap-1">
              <SessionCard
                template={rec.template}
                byId={byId}
                catalog={catalog}
                unit={account.settings.units.weight}
                editable
                defaultOpen={false}
                onChange={(t) => void save(rec, t)}
                onDelete={() => void deleteRecord('templates', rec.id, db)}
              />
              <div className="flex justify-end">
                <Button size="sm" variant="ghost" icon={<CopyPlus className="size-4" />} disabled={!clients.length || rec.template.exercises.length === 0} onClick={() => setDupFor(rec)}>
                  Duplicate for a client
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Sheet open={!!dupFor} onClose={() => setDupFor(null)} title={`Add “${dupFor?.template.name ?? ''}” to…`}>
        <ul className="-mx-5 divide-y divide-line">
          {clients.map((r) => (
            <li key={r.id}>
              <ListRow
                left={<Avatar profile={{ displayName: r.client.displayName, username: '', avatarUrl: r.client.avatarUrl }} size={32} />}
                title={r.client.displayName}
                subtitle="Opens their program builder with this session added"
                onClick={() => {
                  const id = dupFor?.id;
                  setDupFor(null);
                  if (id) nav(`/coaching/client/${r.id}/program?template=${encodeURIComponent(id)}`);
                }}
              />
            </li>
          ))}
        </ul>
      </Sheet>
    </section>
  );
}
