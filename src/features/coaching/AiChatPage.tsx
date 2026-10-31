/**
 * /coaching/ai — full-screen AI coach conversation.
 * History lives on the server (aiApi.history); the unsent draft and the one unconfirmed message live in
 * account-scoped kv so they survive reloads and offline. Every send carries a client uuid, and Retry reuses it,
 * so the server can de-duplicate.
 * An empty conversation opens with an app-rendered, personalized welcome (ai/welcome.ts): no model call, nothing
 * stored, so refreshes and parallel tabs can't duplicate it or cost anything. Quick-reply chips under it send a normal
 * user message, so the real AI answers. Replies may carry a collapsed
 * "Why this?" and one action card: a this-week plan (ai/WeekPlanCard.tsx), a meal plan (ai/MealPlanCard.tsx) or
 * recipe cards (ai/RecipeCards.tsx). AI text and "Why this?" render as a safe Markdown subset (ai/markdown.tsx);
 * valid [[open:/path|Label]] markers become in-app buttons under the message. User messages stay plain text.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { ArrowUpRight, Bot, ClipboardCheck, CloudOff, MoreVertical, Pause, Play, RotateCcw, SendHorizontal, Settings2, Sparkles, Trash2, Lightbulb, Pencil, AlertTriangle } from 'lucide-react';
import { Badge, Button, ConfirmDialog, IconButton, ListRow, Notice, Sheet, Spinner, cx } from '@/components/ui';
import { useToast } from '@/components/toast';
import { aiApi, type AiChatMessage } from '@/backend/ai';
import type { AiAvailability, AiMessage, AiSettings, AiUsage, CoachingRelationship, ProgramProposal } from '@/backend/coachingContract';
import { kvGet, kvSet } from '@/db/repo';
import { useApp } from '@/state/app';
import { uuid } from '@/lib/id';
import {
  AI_DRAFT_KEY, AI_HISTORY_CACHE_KEY, AI_MESSAGE_MAX, AI_PENDING_KEY, CHECKIN_REVIEW_TEXT, classifyAiError, isHardUnavailable, mergeConversation,
  consentOutdated, providerLabel, settingsActive, SUGGESTED_QUESTIONS, upsertMessages, usageLine, WELCOME_CHIPS, type AiMode, type ClassifiedAiError, type PendingSend,
} from './ai/model';
import { useActiveCoach, useAiBoot } from './ai/useAi';
import { buildWelcome, localHour, recentRecord } from './ai/welcome';
import { WeekPlanCard } from './ai/WeekPlanCard';
import { MealPlanCard } from './ai/MealPlanCard';
import { RecipeCards } from './ai/RecipeCards';
import { Markdown } from './ai/markdown';
import { extractOpenLinks } from '../../../supabase/functions/_shared/ai/appGuide';
import { humanizeDates } from '../../../supabase/functions/_shared/ai/humanDates';
import { useActiveProgram, useAllActivities, useAllSessions } from '@/features/train/hooks';
import { todayISO } from '@/lib/dates';
import { useExercises } from '@/data/catalog';
import type { LiftDb } from '@/db/db';
import type { ActivityLog, CoachStyle, Exercise, ID, ISODate, Program, WeightUnit, WorkoutSession } from '@/domain/types';
import { AiBadge, AiGuest, AiUnavailable, availabilityCopy, BackButton, ShareButton, ShareWithCoachDialog } from './ai/parts';
import { EmptyChatArt } from '@/components/illustrations';

export default function AiChatPage() {
  const nav = useNavigate();
  const { boot, reload, setSettings, setUsage } = useAiBoot();

  if (boot.phase === 'loading')
    return (
      <ChatShell>
        <Spinner label="Loading AI coach" />
      </ChatShell>
    );
  if (boot.phase === 'guest')
    return (
      <ChatShell>
        <AiGuest />
      </ChatShell>
    );
  if (isHardUnavailable(boot.availability))
    return (
      <ChatShell>
        <AiUnavailable reason={(boot.availability as Extract<AiAvailability, { available: false }>).reason} />
      </ChatShell>
    );
  const s = boot.settings;
  const reconsent = consentOutdated(s, boot.availability);
  const off = (s === null || (s !== undefined && !settingsActive(s, boot.availability))) || (!boot.availability.available && boot.availability.reason === 'disabled');
  if (off)
    return (
      <ChatShell>
        <div className="flex flex-col items-center text-center px-6 py-10 gap-3">
          <div className="size-12 rounded-2xl bg-surface-2 flex items-center justify-center text-accent">
            <Sparkles className="size-6" aria-hidden />
          </div>
          <h2 className="text-base font-semibold">{reconsent ? 'Please review the AI coach again' : s && s.consentAt ? 'The AI coach is turned off' : 'Set up your AI coach'}</h2>
          <p className="text-sm text-muted max-w-xs">
            {reconsent
              ? `The AI coach now uses ${providerLabel(boot.availability)}. Check what would be sent and agree again before chatting.`
              : s && s.consentAt
              ? 'Turn it back on to keep chatting. Your earlier conversation is still here until you clear it.'
              : 'A short setup: check your details, choose what the AI coach may use, and agree to how it works.'}
          </p>
          {s && s.consentAt && !reconsent ? (
            <Button variant="primary" onClick={() => nav('/coaching/ai/settings')}>
              Open AI coach settings
            </Button>
          ) : (
            <Button variant="primary" onClick={() => nav('/coaching/ai/setup')}>
              Set up AI coach
            </Button>
          )}
        </div>
      </ChatShell>
    );

  return <Chat availability={boot.availability} usage={boot.usage} settings={s} reload={reload} setSettings={setSettings} setUsage={setUsage} />;
}

function ChatShell({ children, menu }: { children: ReactNode; menu?: ReactNode }) {
  return (
    <div className="min-h-dvh flex flex-col">
      <header className="sticky top-0 z-30 bg-bg/95 backdrop-blur border-b border-line pt-safe">
        <div className="mx-auto max-w-2xl flex items-center gap-1 px-2 min-h-14">
          <BackButton />
          <div className="flex-1 min-w-0 flex items-center gap-2 px-1">
            <h1 className="text-lg font-semibold truncate">AI coach</h1>
            <AiBadge />
          </div>
          {menu}
        </div>
      </header>
      <div className="flex-1 flex flex-col mx-auto w-full max-w-2xl">{children}</div>
    </div>
  );
}

function Chat({
  availability, usage, settings, reload, setSettings, setUsage,
}: {
  availability: AiAvailability;
  usage?: AiUsage;
  settings: AiSettings | undefined;
  reload: () => Promise<void>;
  setSettings: (s: AiSettings) => void;
  setUsage: (u: Partial<AiUsage>) => void;
}) {
  const nav = useNavigate();
  const toast = useToast();
  const { db, online, account } = useApp();
  const coach = useActiveCoach();
  const program = useActiveProgram();
  const sessions = useAllSessions();
  const activities = useAllActivities();
  const today = todayISO(account.settings.timeZone);
  const weekStart = account.settings.weekStart;
  const [history, setHistory] = useState<AiChatMessage[] | undefined>(undefined);
  const [historyNote, setHistoryNote] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingSend | null>(null);
  const [draft, setDraft] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [sendError, setSendError] = useState<ClassifiedAiError | null>(null);
  const [proposals, setProposals] = useState<Record<string, ProgramProposal>>({});
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState<null | 'clear' | 'pause'>(null);
  const [share, setShare] = useState<{ key: string; text: string } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const paused = !!settings?.paused;
  const providerDown = !availability.available && availability.reason === 'provider_down';
  const offline = !online || (!availability.available && availability.reason === 'offline');
  const limitReached = !!usage && usage.limitRequests > 0 && usage.requests >= usage.limitRequests;
  const blocked = offline || providerDown || paused || limitReached;

  /* ---------------------------------------------------------- loading */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [d, p, cache] = await Promise.all([
        kvGet<string>(AI_DRAFT_KEY, db).catch(() => undefined),
        kvGet<PendingSend | null>(AI_PENDING_KEY, db).catch(() => undefined),
        kvGet<AiChatMessage[]>(AI_HISTORY_CACHE_KEY, db).catch(() => undefined),
      ]);
      if (cancelled) return;
      setDraft(typeof d === 'string' ? d : '');
      // A message left "sending" by a closed tab was never confirmed: offer Retry with the same id.
      if (p) setPending(p.status === 'sending' ? { ...p, status: 'failed', error: 'Not confirmed yet. Tap Retry to send it again.' } : p);
      setLoaded(true);
      if (!online) {
        setHistory(cache ?? []);
        if (cache?.length) setHistoryNote('Showing your conversation as it was when you were last online.');
        return;
      }
      try {
        const h = await aiApi.history(100);
        if (cancelled) return;
        setHistory(h);
        setHistoryNote(null);
        void kvSet(AI_HISTORY_CACHE_KEY, h.slice(-100), db).catch(() => undefined);
        if (p && h.some((m) => m.id === p.id)) {
          setPending(null);
          void kvSet(AI_PENDING_KEY, null, db).catch(() => undefined);
        }
      } catch (e) {
        if (cancelled) return;
        setHistory(cache ?? []);
        setHistoryNote(cache?.length ? 'Couldn’t refresh your conversation; showing the last copy on this device.' : classifyAiError(e).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [db, online]);

  const conversation = useMemo(() => mergeConversation(history ?? [], pending), [history, pending]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ block: 'end' });
  }, [conversation.length, pending?.status]);

  /* ------------------------------------------------------------ draft */
  const updateDraft = useCallback(
    (text: string) => {
      setDraft(text);
      void kvSet(AI_DRAFT_KEY, text, db).catch(() => undefined);
    },
    [db],
  );

  const persistPending = useCallback(
    (p: PendingSend | null) => {
      setPending(p);
      void kvSet(AI_PENDING_KEY, p, db).catch(() => undefined);
    },
    [db],
  );

  /* ------------------------------------------------------------- send */
  async function run(p: PendingSend) {
    setSendError(null);
    const sending: PendingSend = { ...p, status: 'sending', error: undefined };
    persistPending(sending);
    try {
      const res = await aiApi.send({ id: p.id, text: p.text, mode: p.mode });
      const userMsg: AiMessage = { id: p.id, role: 'user', content: p.text, createdAt: p.createdAt, status: 'sent' };
      setHistory((h) => {
        const next = upsertMessages(h ?? [], [userMsg, res.reply]);
        void kvSet(AI_HISTORY_CACHE_KEY, next.slice(-100), db).catch(() => undefined);
        return next;
      });
      if (res.proposal) setProposals((m) => ({ ...m, [res.proposal!.id]: res.proposal! }));
      persistPending(null);
      if (usage) setUsage({ requests: usage.requests + 1 });
    } catch (e) {
      const c = classifyAiError(e);
      setSendError(c);
      persistPending({ ...p, status: 'failed', error: c.message });
      if (c.kind === 'rate_limited' && c.usage) setUsage(c.usage);
      if (c.kind === 'paused' || c.kind === 'disabled' || c.kind === 'unavailable') void reload();
    }
  }

  const canCompose = loaded && !pending;
  const canSend = canCompose && !blocked && draft.trim().length > 0;

  function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!canSend) return;
    start(draft.trim(), 'chat');
  }
  /** `fromDraft`: the text came from the composer, so clear it (quick replies leave a typed draft alone). */
  function start(text: string, mode: AiMode, fromDraft = mode === 'chat') {
    if (blocked) return;
    const p: PendingSend = { id: uuid(), text, mode, status: 'sending', createdAt: new Date().toISOString() };
    if (fromDraft) updateDraft('');
    void run(p);
  }
  function retry() {
    if (pending && !blocked) void run(pending);
  }
  function editPending() {
    if (!pending) return;
    updateDraft(draft ? `${draft}\n${pending.text}` : pending.text);
    persistPending(null);
    setSendError(null);
    inputRef.current?.focus();
  }

  /* ------------------------------------------------------------- menu */
  async function setPaused(next: boolean) {
    setBusy('pause');
    try {
      setSettings(await aiApi.saveSettings({ paused: next }));
      toast.show(next ? 'AI coach paused' : 'AI coach resumed', { tone: 'success' });
      setMenuOpen(false);
    } catch (e) {
      toast.show(classifyAiError(e).message, { tone: 'error' });
    } finally {
      setBusy(null);
    }
  }
  async function clearHistory() {
    setBusy('clear');
    try {
      await aiApi.clearHistory();
      setHistory([]);
      setProposals({});
      await kvSet(AI_HISTORY_CACHE_KEY, [], db).catch(() => undefined);
      toast.show('Conversation cleared', { tone: 'success' });
      setConfirmClear(false);
      setMenuOpen(false);
    } catch (e) {
      toast.show(classifyAiError(e).message, { tone: 'error' });
    } finally {
      setBusy(null);
    }
  }

  const menu = (
    <IconButton label="AI coach menu" onClick={() => setMenuOpen(true)}>
      <MoreVertical className="size-5" />
    </IconButton>
  );
  const uLine = usageLine(usage);

  return (
    <ChatShell menu={menu}>
      {/* status banners */}
      <div className="px-3 pt-3 space-y-2" aria-live="polite">
        {offline && (
          <Notice tone="warn" className="flex gap-2 items-start">
            <CloudOff className="size-4 mt-0.5 shrink-0" aria-hidden />
            <span>You’re offline. Keep writing — your draft is saved on this device and you can send it when you’re back online.</span>
          </Notice>
        )}
        {!offline && providerDown && (
          <Notice tone="warn" className="flex gap-2 items-start">
            <AlertTriangle className="size-4 mt-0.5 shrink-0" aria-hidden />
            <div className="flex-1">
              <p>{availabilityCopy('provider_down').body}</p>
              <Button size="sm" className="mt-2" onClick={() => void reload()}>
                Check again
              </Button>
            </div>
          </Notice>
        )}
        {paused && (
          <Notice tone="info" className="flex gap-2 items-center">
            <Pause className="size-4 shrink-0" aria-hidden />
            <span className="flex-1">The AI coach is paused. It won’t read your data or reply until you resume.</span>
            <Button size="sm" variant="primary" loading={busy === 'pause'} onClick={() => void setPaused(false)}>
              Resume
            </Button>
          </Notice>
        )}
        {(limitReached || sendError?.kind === 'rate_limited') && (
          <Notice tone="warn">
            You’ve reached today’s AI coach limit{uLine ? ` (${uLine})` : ''}. It resets tomorrow — your message is kept.
          </Notice>
        )}
        {historyNote && <Notice>{historyNote}</Notice>}
      </div>

      {/* conversation */}
      <div className="flex-1 px-3 py-3">
        {history === undefined ? (
          <Spinner label="Loading conversation" />
        ) : (
          <>
            {conversation.length === 0 && settings && (
              <>
                <div className="w-32 mx-auto mb-3">
                  <EmptyChatArt />
                </div>
                <WelcomeMessage
                  settings={settings}
                  goal={account.profile.goal}
                  displayName={account.profile.displayName}
                  timeZone={account.settings.timeZone}
                  unit={account.settings.units.weight}
                  program={program}
                  sessions={sessions}
                  activities={activities}
                  today={today}
                  weekStart={weekStart}
                />
                {canCompose && !blocked && (
                  <div className="flex flex-wrap gap-2 mb-4" role="group" aria-label="Quick replies">
                    {WELCOME_CHIPS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => start(c, 'chat', false)}
                        className="min-h-10 px-3.5 rounded-full border border-accent/40 bg-accent-soft text-sm font-medium hover:bg-surface-2"
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
            <ol className="space-y-4" aria-label="Conversation">
              {conversation.map((m) => (
                <MessageItem
                  key={m.id}
                  m={m}
                  week={{ program, sessions, activities, today, weekStart, db }}
                  pending={m.pending}
                  proposal={m.proposalId ? proposals[m.proposalId] : undefined}
                  coach={coach}
                  onShare={() => setShare({ key: m.id, text: extractOpenLinks(m.content).text })}
                  onRetry={retry}
                  onEdit={editPending}
                  retryDisabled={blocked}
                />
              ))}
            </ol>
          </>
        )}
        <div ref={bottomRef} />
      </div>

      {/* composer */}
      <div className="sticky bottom-0 bg-bg/95 backdrop-blur border-t border-line px-3 pt-2 pb-safe">
        {canCompose && draft.trim() === '' && !blocked && (
          <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1" role="group" aria-label="Suggested questions">
            <button
              type="button"
              onClick={() => start(CHECKIN_REVIEW_TEXT, 'checkin_review')}
              className="shrink-0 min-h-10 px-3.5 rounded-full border border-accent/40 bg-accent-soft text-accent text-sm font-medium inline-flex items-center gap-1.5"
            >
              <ClipboardCheck className="size-4" aria-hidden /> Check-in review
            </button>
            {SUGGESTED_QUESTIONS.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => {
                  updateDraft(q);
                  inputRef.current?.focus();
                }}
                className="shrink-0 min-h-10 px-3.5 rounded-full border border-line text-sm hover:bg-surface-2 inline-flex items-center gap-1.5"
              >
                <Lightbulb className="size-3.5 text-muted" aria-hidden /> {q}
              </button>
            ))}
          </div>
        )}
        <form onSubmit={submit} className="flex items-end gap-2">
          <label htmlFor="ai-composer" className="sr-only">
            Message the AI coach
          </label>
          <textarea
            id="ai-composer"
            ref={inputRef}
            value={draft}
            maxLength={AI_MESSAGE_MAX}
            disabled={!loaded}
            rows={Math.min(6, Math.max(1, draft.split('\n').length))}
            placeholder={pending ? 'Waiting for your last message…' : 'Ask your AI coach…'}
            onChange={(e) => updateDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
            }}
            aria-describedby="ai-composer-hint"
            className="flex-1 min-h-11 max-h-40 rounded-xl bg-surface-2 border border-line px-3 py-2.5 text-[16px] text-ink placeholder:text-faint focus:border-accent focus:outline-none resize-none"
          />
          <IconButton type="submit" label="Send" disabled={!canSend} className={cx(canSend && 'bg-accent text-accent-ink hover:bg-accent-strong')}>
            <SendHorizontal className="size-5" />
          </IconButton>
        </form>
        <p id="ai-composer-hint" className="text-[11px] text-faint mt-1 mb-1">
          {offline
            ? 'Offline — draft saved on this device.'
            : paused
              ? 'Paused — resume to send.'
              : pending?.status === 'failed'
                ? 'Retry or edit your last message before sending another.'
                : `AI replies are suggestions, not medical advice.${uLine ? ` ${uLine}.` : ''}`}
        </p>
      </div>

      <Sheet open={menuOpen} onClose={() => setMenuOpen(false)} title="AI coach">
        {uLine && <p className="text-sm text-muted mb-2">{uLine}</p>}
        <div className="-mx-5">
          <ListRow left={<Settings2 className="size-5 text-muted" />} title="Settings" subtitle="Data access, notes, pause or turn off" onClick={() => nav('/coaching/ai/settings')} />
          <ListRow left={<Sparkles className="size-5 text-muted" />} title="AI suggestions" subtitle="Suggested plan changes to review" onClick={() => nav('/coaching/ai/proposals')} />
          <ListRow
            left={paused ? <Play className="size-5 text-muted" /> : <Pause className="size-5 text-muted" />}
            title={paused ? 'Resume AI coach' : 'Pause AI coach'}
            subtitle={paused ? 'Start replying again' : 'Stop using your data and replying until you resume'}
            onClick={() => (busy ? undefined : void setPaused(!paused))}
          />
          <ListRow left={<Trash2 className="size-5 text-danger" />} title={<span className="text-danger">Clear history</span>} subtitle="Delete this conversation from your account" onClick={() => setConfirmClear(true)} />
        </div>
      </Sheet>

      <ConfirmDialog
        open={confirmClear}
        title="Clear AI conversation?"
        danger
        confirmLabel="Clear history"
        busy={busy === 'clear'}
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => void clearHistory()}
        body="This deletes your AI coach messages from your account and this device. Your AI coach notes, suggestions you applied, and your plan are not affected. It can’t be undone."
      />

      {share && coach && <ShareWithCoachDialog key={share.key} open text={share.text} relationship={coach} onClose={() => setShare(null)} />}
    </ChatShell>
  );
}

/** First message of an empty conversation — built in the app from permitted saved context (no model call). */
function WelcomeMessage({
  settings, goal, displayName, timeZone, unit, program, sessions, activities, today, weekStart,
}: {
  settings: AiSettings;
  goal?: Parameters<typeof buildWelcome>[0]['goal'];
  displayName?: string;
  timeZone: string;
  unit: WeightUnit;
  program: Program | null | undefined;
  sessions: WorkoutSession[] | undefined;
  activities: ActivityLog[] | undefined;
  today: ISODate;
  weekStart: 0 | 1;
}) {
  const { byId } = useExercises();
  if (program === undefined || sessions === undefined) return null; // local data still loading (instant in practice)
  const style: CoachStyle = settings.coachStyle;
  const record = settings.scopes.training ? safeRecord(sessions, byId, unit, today) : null;
  const w = buildWelcome({ scopes: settings.scopes, goal, displayName, hour: localHour(timeZone), style, record, program, sessions, activities, today, weekStart });
  return (
    <article aria-label="AI coach welcome" className="max-w-[92%] mb-4">
      <div className="flex items-center gap-2 mb-1">
        <span className="size-6 rounded-full bg-surface-3 flex items-center justify-center text-info" aria-hidden>
          <Bot className="size-3.5" />
        </span>
        <span className="text-sm font-semibold">AI coach</span>
        <AiBadge />
      </div>
      <div className="rounded-2xl rounded-tl-md bg-surface border border-line px-3.5 py-2.5 text-[15px] space-y-1.5">
        <p className="font-medium">{w.greeting}</p>
        {w.lines.map((l, i) => (
          <p key={i}>{l}</p>
        ))}
        <p>{w.closing}</p>
      </div>
      <p className="mt-1 text-[11px] text-faint">From your saved details · replies are AI suggestions, not medical advice. Plan changes only happen if you apply them.</p>
    </article>
  );
}

function safeRecord(sessions: WorkoutSession[], byId: Map<ID, Exercise>, unit: WeightUnit, today: ISODate) {
  try {
    return recentRecord(sessions, byId, unit, today);
  } catch {
    return null;
  }
}

/** Grounding chips; replies stored before 0.7.0 said "1 recent workouts". */
export function groundingLabel(g: string): string {
  return g.replace(/^1 recent workouts$/, '1 recent workout');
}

interface WeekCtx {
  program: Program | null | undefined;
  sessions: WorkoutSession[] | undefined;
  activities: ActivityLog[] | undefined;
  today: ISODate;
  weekStart: 0 | 1;
  db: LiftDb;
}

function MessageItem({
  m, week, pending, proposal, coach, onShare, onRetry, onEdit, retryDisabled,
}: {
  m: AiChatMessage;
  week: WeekCtx;
  pending?: PendingSend;
  proposal?: ProgramProposal;
  coach: CoachingRelationship | null;
  onShare: () => void;
  onRetry: () => void;
  onEdit: () => void;
  retryDisabled: boolean;
}) {
  const nav = useNavigate();
  if (m.role === 'user') {
    return (
      <li className="flex justify-end">
        <div className="max-w-[85%] flex flex-col items-end">
          <span className="sr-only">You:</span>
          <div className={cx('rounded-2xl rounded-br-md px-3.5 py-2.5 whitespace-pre-wrap break-words text-[15px]', pending?.status === 'failed' ? 'bg-surface-2 border border-danger/40' : 'bg-accent-soft border border-accent/30')}>
            {m.content}
          </div>
          {pending?.status === 'sending' && (
            <span className="text-xs text-muted mt-1" role="status">
              Sending…
            </span>
          )}
          {pending?.status === 'failed' && (
            <div className="mt-1 flex flex-wrap items-center justify-end gap-1">
              <span className="text-xs text-danger">Not sent{pending.error ? ` — ${pending.error}` : ''}</span>
              <Button size="sm" variant="secondary" icon={<RotateCcw className="size-4" />} onClick={onRetry} disabled={retryDisabled}>
                Retry
              </Button>
              <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} onClick={onEdit}>
                Edit
              </Button>
            </div>
          )}
        </div>
      </li>
    );
  }
  const body = extractOpenLinks(humanizeDates(m.content, week.today));
  const whyText = m.why ? extractOpenLinks(humanizeDates(m.why, week.today)).text : '';
  return (
    <li>
      <article aria-label="AI coach message" className="max-w-[92%]">
        <div className="flex items-center gap-2 mb-1">
          <span className="size-6 rounded-full bg-surface-3 flex items-center justify-center text-info" aria-hidden>
            <Bot className="size-3.5" />
          </span>
          <span className="text-sm font-semibold">AI coach</span>
          <AiBadge />
        </div>
        <div className="rounded-2xl rounded-tl-md bg-surface border border-line px-3.5 py-2.5 text-[15px]" data-testid="ai-message-body">
          <Markdown text={body.text} />
        </div>
        {body.links.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-2" role="group" aria-label="Open in the app">
            {body.links.map((l) => (
              <Button key={l.path} size="sm" variant="secondary" icon={<ArrowUpRight className="size-4" />} onClick={() => nav(l.path)}>
                {l.label}
              </Button>
            ))}
          </div>
        )}
        {whyText && (
          <details className="mt-1.5 group">
            <summary className="cursor-pointer select-none text-sm text-muted min-h-11 inline-flex items-center gap-1 hover:text-ink">Why this?</summary>
            <Markdown text={whyText} className="text-sm text-muted px-1 pb-1" />
          </details>
        )}
        {m.weekPlan && (
          <WeekPlanCard plan={m.weekPlan} program={week.program} sessions={week.sessions} activities={week.activities} today={week.today} weekStart={week.weekStart} db={week.db} />
        )}
        {m.mealPlan && <MealPlanCard plan={m.mealPlan} />}
        {m.recipes && <RecipeCards suggestions={m.recipes} />}
        {m.grounding && m.grounding.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted">Based on:</span>
            <ul className="contents">
              {m.grounding.map((g, i) => (
                <li key={i}>
                  <Badge>{groundingLabel(g)}</Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
        {m.proposalId && (
          <Link
            to={`/coaching/ai/proposals?id=${encodeURIComponent(m.proposalId)}`}
            className="mt-2 flex items-start gap-3 rounded-2xl border border-accent/40 bg-accent-soft px-3.5 py-3 min-h-14 hover:bg-surface-2"
          >
            <Sparkles className="size-5 text-accent shrink-0 mt-0.5" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block font-semibold text-[15px]">
                {proposal && !proposal.baseProgramId && proposal.target !== 'for_coach_review' ? 'Add to my program — review' : 'Suggested plan change — review'}
              </span>
              <span className="block text-xs text-muted mt-0.5">
                {proposal
                  ? `${proposal.program.name}${proposal.changeSummary[0] ? ` · ${proposal.changeSummary[0]}` : ''}`
                  : 'An AI suggestion. Preview it, then add it to your program — nothing changes until you do.'}
              </span>
            </span>
          </Link>
        )}
        <div className="mt-1 flex items-center justify-between gap-2 flex-wrap">
          <p className="text-[11px] text-faint">AI suggestion · general guidance, not medical advice</p>
          {coach && <ShareButton onClick={onShare} />}
        </div>
      </article>
    </li>
  );
}

