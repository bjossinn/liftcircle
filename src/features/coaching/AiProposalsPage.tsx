/**
 * /coaching/ai/proposals — AI plan suggestions (drafts until the user applies them).
 * ?id=<proposalId> opens one suggestion (linked from the chat).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronRight, MessageCircle, Sparkles } from 'lucide-react';
import { Badge, Button, Card, EmptyState, ErrorState, ListRow, Page, SectionTitle, Spinner } from '@/components/ui';
import { aiApi } from '@/backend/ai';
import type { ProgramProposal } from '@/backend/coachingContract';
import { useApp } from '@/state/app';
import { classifyAiError, PROPOSAL_VIEW_LABEL, proposalView, type ClassifiedAiError } from './ai/model';
import { flushAcks } from './ai/apply';
import { useActiveCoach } from './ai/useAi';
import { AiGuest, AiUnavailable, BackButton } from './ai/parts';
import { ProposalDetail } from './ai/ProposalDetail';

export default function AiProposalsPage() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('id');
  const { db, auth, online, backendConfigured } = useApp();
  const programs = useLiveQuery(() => db.programs.toArray(), [db]);
  const coach = useActiveCoach();
  const [items, setItems] = useState<ProgramProposal[] | undefined>(undefined);
  const [error, setError] = useState<ClassifiedAiError | null>(null);

  const canLoad = backendConfigured && auth.status !== 'guest' && auth.status !== 'loading' && online;

  const load = useCallback(async () => {
    setError(null);
    try {
      await flushAcks(db, (id, accept, applied) => aiApi.respondProposal(id, accept, applied)).catch(() => 0);
      const list = await aiApi.listProposals();
      setItems(list.filter((p) => p.authorKind === 'ai').sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    } catch (e) {
      setError(classifyAiError(e));
    }
  }, [db]);

  useEffect(() => {
    if (canLoad) void load();
  }, [canLoad, load]);

  const live = useMemo(() => (programs ?? []).filter((p) => !p.deletedAt), [programs]);
  const selected = selectedId ? items?.find((p) => p.id === selectedId) : undefined;
  const back = <BackButton />;
  const title = selectedId ? 'AI suggestion' : 'AI suggestions';

  if (!backendConfigured)
    return (
      <Page title={title} back={back}>
        <AiUnavailable reason="backend_missing" />
      </Page>
    );
  if (auth.status === 'guest')
    return (
      <Page title={title} back={back}>
        <AiGuest />
      </Page>
    );
  if (!online)
    return (
      <Page title={title} back={back}>
        <AiUnavailable reason="offline" />
      </Page>
    );
  if (error)
    return (
      <Page title={title} back={back}>
        {error.kind === 'unavailable' && error.reason ? (
          <AiUnavailable reason={error.reason} onRetry={() => void load()} />
        ) : (
          <ErrorState title="Couldn’t load AI suggestions" message={error.message} onRetry={() => void load()} />
        )}
      </Page>
    );
  if (items === undefined || programs === undefined)
    return (
      <Page title={title} back={back}>
        <Spinner label="Loading suggestions" />
      </Page>
    );

  if (selectedId) {
    return (
      <Page title={title} back={back}>
        {selected ? (
          <ProposalDetail
            key={selected.id}
            proposal={selected}
            programs={live}
            coach={coach}
            onChanged={(np) => setItems((xs) => xs?.map((x) => (x.id === np.id ? np : x)))}
          />
        ) : (
          <EmptyState
            title="Suggestion not found"
            body="It may have been removed when the conversation was cleared."
            action={<Button onClick={() => setParams({})}>See all suggestions</Button>}
          />
        )}
      </Page>
    );
  }

  const withView = items.map((p) => ({ p, view: proposalView(p, live) }));
  const open = withView.filter((x) => x.view === 'pending' || x.view === 'stale');
  const earlier = withView.filter((x) => x.view !== 'pending' && x.view !== 'stale');

  const row = ({ p, view }: (typeof withView)[number]) => (
    <li key={p.id}>
      <ListRow
        onClick={() => setParams({ id: p.id })}
        left={
          <span className="size-9 rounded-xl bg-accent-soft text-accent flex items-center justify-center" aria-hidden>
            <Sparkles className="size-4" />
          </span>
        }
        title={p.program.name}
        subtitle={
          <>
            <span className="sr-only">AI suggestion · </span>
            {new Date(p.createdAt).toLocaleDateString()}
            {p.target === 'for_coach_review' ? ' · for your coach to review' : ''}
            {p.changeSummary[0] ? ` · ${p.changeSummary[0]}` : ''}
          </>
        }
        right={
          <span className="flex items-center gap-1">
            <Badge tone={PROPOSAL_VIEW_LABEL[view].tone}>{PROPOSAL_VIEW_LABEL[view].label}</Badge>
            <ChevronRight className="size-4" aria-hidden />
          </span>
        }
      />
    </li>
  );

  return (
    <Page title={title} back={back}>
      <p className="text-sm text-muted px-1">
        Plan changes the AI coach suggested. Each one is labelled as an AI suggestion and nothing changes until you review and apply it.
      </p>
      {items.length === 0 ? (
        <EmptyState
          icon={<Sparkles className="size-6" />}
          title="No suggestions yet"
          body="Ask the AI coach for help with your schedule or progression — if it proposes a plan change, it shows up here."
          action={
            <Button variant="primary" icon={<MessageCircle className="size-4" />} onClick={() => nav('/coaching/ai')}>
              Open AI coach
            </Button>
          }
        />
      ) : (
        <>
          {open.length > 0 && (
            <>
              <SectionTitle>To review</SectionTitle>
              <Card as="section" className="overflow-hidden">
                <ul className="divide-y divide-line">{open.map(row)}</ul>
              </Card>
            </>
          )}
          {earlier.length > 0 && (
            <>
              <SectionTitle>Earlier</SectionTitle>
              <Card as="section" className="overflow-hidden">
                <ul className="divide-y divide-line">{earlier.map(row)}</ul>
              </Card>
            </>
          )}
        </>
      )}
    </Page>
  );
}
