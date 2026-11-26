/**
 * /coaching/ai — full-screen training assistant conversation.
 * History lives on the server (aiApi.history); the unsent draft and the one unconfirmed message live in
 * account-scoped kv so they survive reloads and offline. Every send carries a client uuid, and Retry reuses it,
 * so the server can de-duplicate.
 * An empty conversation opens with an app-rendered, personalized welcome (ai/welcome.ts): no model call, nothing
 * stored, so refreshes and parallel tabs can't duplicate it or cost anything. Quick-reply chips under it send a normal
 * user message, so the real AI answers. Replies may carry a collapsed
 * "Why this?" and one action card: a this-week plan (ai/WeekPlanCard.tsx), a meal plan (ai/MealPlanCard.tsx) or
 * recipe cards (ai/RecipeCards.tsx). AI text and "Why this?" render as a safe Markdown subset (ai/markdown.tsx);
 * valid [[open:/path|Label]] markers become in-app buttons under the message. User messages stay plain text.
 *
 * State-aware coach (roadmap item 7): the workout logger and summary open the Coach with a contextual request
 * (ai/workoutContext.ts). The chat sends it once with a fresh snapshot of that workout attached (or, when it can't send
 * yet, puts it in the composer with the workout attached, kept on the device until it's sent or removed). Only while
 * Training is shared: otherwise nothing about the workout is written, attached or sent. A reply may carry a today-only
 * workout change
 * (ai/SessionAdjustmentCard.tsx). First use (and a provider change) shows the single-step consent (ai/AiConsent.tsx).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { ArrowDown, ArrowUpRight, Bot, ClipboardCheck, CloudOff, Dumbbell, Loader2, MoreVertical, Pause, Play, RotateCcw, SendHorizontal, Settings2, Sparkles, Square, Trash2, Lightbulb, Pencil, AlertTriangle, X } from 'lucide-react';
import { Badge, Button, ConfirmDialog, IconButton, ListRow, Notice, Sheet, Spinner, cx } from '@/components/ui';
import { useToast } from '@/components/toast';
import { aiApi, type AiChatMessage, type SendResult, type StreamPhase } from '@/backend/ai';
import type { AiAvailability, AiMessage, AiSettings, AiUsage, CoachingRelationship, ProgramProposal } from '@/backend/coachingContract';
import { kvGet, kvSet } from '@/db/repo';
import { useApp } from '@/state/app';
import { trackAiAction } from '@/analytics/analytics';
import { uuid } from '@/lib/id';
import {
  AI_DRAFT_KEY, AI_HISTORY_CACHE_KEY, AI_MESSAGE_MAX, AI_PENDING_KEY, checkinReviewText, classifyAiError, isHardUnavailable, mergeConversation, pendingErrorText,
  consentOutdated, providerLabel, settingsActive, suggestedQuestions, upsertMessages, usageLine, welcomeChips, type AiMode, type ClassifiedAiError, type PendingSend,
} from './ai/model';
import { useActiveCoach, useAiBoot } from './ai/useAi';
import { buildWelcome, localHour, recentRecord } from './ai/welcome';
import { WeekPlanCard } from './ai/WeekPlanCard';
import { MealPlanCard } from './ai/MealPlanCard';
import { RecipeCards } from './ai/RecipeCards';
import { SessionAdjustmentCard } from './ai/SessionAdjustmentCard';
import { AiConsent } from './ai/AiConsent';
import {
  AI_ATTACHED_REQUEST_KEY, AI_DRAFT_GENERATED_KEY, loadAttachedRequest, prepareCoachRequest, rangesAfterTrim, stripGenerated, takeCoachRequest, trackDraftEdit,
  type CoachRequest, type DraftProvenance, type TextRanges,
} from './ai/workoutContext';
import { syncBeforeAi } from './ai/syncBarrier';
import { isCancelled } from './ai/inProgress';
import { canStop, previewText, recoverReply, sendReply, SLOW_AFTER_MS, stopReply, type Prepare, type Settled } from './ai/replyFlow';
import { Markdown } from './ai/markdown';
import { extractOpenLinks, type GuideFeatures } from '../../../supabase/functions/_shared/ai/appGuide';
import { isFeatureEnabled } from '@/config/featureFlags';
import { humanizeDates } from '../../../supabase/functions/_shared/ai/humanDates';
import { detectLang } from '../../../supabase/functions/_shared/ai/lang';
import { useActiveProgram, useAllActivities, useAllSessions } from '@/features/train/hooks';
import { todayISO } from '@/lib/dates';
import { useExercises } from '@/data/catalog';
import type { LiftDb } from '@/db/db';
import type { ActivityLog, CoachStyle, Exercise, ID, ISODate, Program, WeightUnit, WorkoutSession } from '@/domain/types';
import { AiBadge, AiGuest, AiUnavailable, availabilityCopy, BackButton, ShareButton, ShareWithCoachDialog } from './ai/parts';
import { EmptyChatArt } from '@/components/illustrations';
import { useT, type MessageKey } from '@/i18n';

/**
 * The reply being produced right now (item 10): only transient UI state. The preview holds chunks of the finished,
 * stored answer as plain text: no cards, links, badges, history writes or analytics until the final result arrives.
 */
type LivePhase = StreamPhase | 'syncing' | 'receiving' | 'reconnecting' | 'waiting';
interface LiveReply {
  id: string;
  phase: LivePhase;
  preview: string;
  stopping: boolean;
  stopNote: MessageKey | null;
  slow: boolean;
  ctrl: AbortController;
  /** A workout question: its flow stops as soon as Training sharing is turned off. */
  workoutQuestion: boolean;
}
const LIVE_KEY: Record<LivePhase, MessageKey> = {
  syncing: 'ai.chat.status.syncing',
  preparing: 'ai.chat.status.preparing',
  training: 'ai.chat.status.training',
  nutrition: 'ai.chat.status.nutrition',
  recipes: 'ai.chat.status.recipes',
  planning: 'ai.chat.status.planning',
  writing: 'ai.chat.status.writing',
  checking: 'ai.chat.status.checking',
  saving: 'ai.chat.status.saving',
  receiving: 'ai.chat.status.receiving',
  reconnecting: 'ai.chat.reconnectingReply',
  waiting: 'ai.chat.waitingForFullReply',
};

/** Item 10 outcomes: the message WAS sent; these say what happened to its reply (shown as written, not as "Not sent"). */
const REPLY_STATE_KEYS = new Set<string>(['ai.chat.replyStopped', 'ai.chat.replyInterrupted', 'ai.chat.replyUnconfirmed', 'ai.chat.replyDiscardedPrivacy', 'ai.error.invalidReply']);

/** Why a workout question can't be sent or retried while Training sharing is off (stored as this key). */
const TRAINING_OFF_PENDING = 'ai.chat.trainingOffPending';

/** This build's switched-on areas, so links to hidden screens (find a coach, the feed) don't render as buttons. */
const appFeatures = (): GuideFeatures => ({ coachMarketplace: isFeatureEnabled('coachMarketplace'), socialFeed: isFeatureEnabled('socialFeed') });

/**
 * How the chat is framed. Full screen (/coaching/ai): back button, no tab bar. Embedded (the Coach tab, /coach): no back
 * button, an optional channel switcher (training assistant ↔ human coaching) under the title, and the composer sits
 * just above the tab bar.
 */
interface ChatChrome {
  embedded: boolean;
  switcher?: ReactNode;
}
const ChatChromeContext = createContext<ChatChrome>({ embedded: false });

/** The training assistant as the Coach tab's main screen (see CoachTabPage). */
export function EmbeddedAiChat({ switcher }: { switcher?: ReactNode }) {
  return (
    <ChatChromeContext.Provider value={{ embedded: true, switcher }}>
      <AiChatPage />
    </ChatChromeContext.Provider>
  );
}

export default function AiChatPage() {
  const nav = useNavigate();
  const { boot, reload, setSettings, setUsage } = useAiBoot();
  const { t } = useT();

  if (boot.phase === 'loading')
    return (
      <ChatShell>
        <Spinner label={t('ai.chat.loading')} />
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
  // First use, or the server now uses another AI provider: the single-step consent, right here in the Coach tab.
  if (off && (s === null || reconsent))
    return (
      <ChatShell>
        <AiConsent availability={boot.availability} settings={s} onEnabled={setSettings} />
      </ChatShell>
    );
  if (off)
    return (
      <ChatShell>
        <div className="flex flex-col items-center text-center px-6 py-10 gap-3">
          <div className="size-12 rounded-2xl bg-surface-2 flex items-center justify-center text-accent">
            <Sparkles className="size-6" aria-hidden />
          </div>
          <h2 className="text-base font-semibold">{reconsent ? t('ai.chat.reviewAgain') : s && s.consentAt ? t('ai.unavailable.disabled.title') : t('ai.chat.setUp')}</h2>
          <p className="text-sm text-muted max-w-xs">
            {reconsent
              ? t('ai.chat.providerChanged', { provider: providerLabel(boot.availability) })
              : s && s.consentAt
              ? t('ai.chat.turnBackOn')
              : t('ai.chat.setupDescription')}
          </p>
          {s && s.consentAt && !reconsent ? (
            <Button variant="primary" onClick={() => nav('/coaching/ai/settings')}>
              {t('ai.chat.openSettings')}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => nav('/coaching/ai/setup')}>
              {t('ai.chat.setupButton')}
            </Button>
          )}
        </div>
      </ChatShell>
    );

  return <Chat availability={boot.availability} usage={boot.usage} settings={s} reload={reload} setSettings={setSettings} setUsage={setUsage} />;
}

function ChatShell({ children, menu }: { children: ReactNode; menu?: ReactNode }) {
  const { embedded, switcher } = useContext(ChatChromeContext);
  const { t } = useT();
  return (
    <div className={cx('flex flex-col', embedded ? 'min-h-[calc(100dvh-57px-env(safe-area-inset-bottom))]' : 'min-h-dvh')}>
      <header className="sticky top-0 z-30 bg-bg/95 backdrop-blur border-b border-line pt-safe">
        <div className={cx('mx-auto max-w-2xl flex items-center gap-1 min-h-14', embedded ? 'pl-4 pr-2' : 'px-2')}>
          {!embedded && <BackButton />}
          <div className={cx('flex-1 min-w-0 flex items-center gap-2', !embedded && 'px-1')}>
            <h1 className="text-lg font-semibold truncate">{embedded ? t('nav.coach') : t('ai.title')}</h1>
            <AiBadge />
          </div>
          {menu}
        </div>
        {embedded && switcher && <div className="mx-auto max-w-2xl px-3 pb-2">{switcher}</div>}
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
  const { embedded } = useContext(ChatChromeContext);
  const toast = useToast();
  const { t } = useT();
  const { db, online, account, auth } = useApp();
  const userId = auth.userId;
  // Sends in flight belong to this account and this screen: an account switch or leaving the chat cancels them (they
  // never go out, or land, under another account).
  const owner = useRef<{ userId: string | undefined; ctrl: AbortController }>({ userId, ctrl: new AbortController() });
  // The reply in progress (item 10). Leaving the chat or switching account DETACHES (never cancels or refunds): the
  // preview is cleared and nothing late is written; the message keeps its id and is recovered from the server later.
  const [live, setLive] = useState<LiveReply | null>(null);
  const liveRef = useRef(live);
  liveRef.current = live;
  const [announce, setAnnounce] = useState('');
  useEffect(() => {
    const ctrl = new AbortController();
    owner.current = { userId, ctrl };
    setLive(null);
    return () => ctrl.abort();
  }, [userId, db]);
  const coach = useActiveCoach();
  const program = useActiveProgram();
  const sessions = useAllSessions();
  const activities = useAllActivities();
  const today = todayISO(account.settings.timeZone);
  const weekStart = account.settings.weekStart;
  const [history, setHistory] = useState<AiChatMessage[] | undefined>(undefined);
  const [historyNote, setHistoryNote] = useState<MessageKey | null>(null);
  const [pending, setPending] = useState<PendingSend | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const [draft, setDraft] = useState('');
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Which parts of the draft the app generated for a contextual request (removed if Training sharing is turned off).
  const [provenance, setProvenance] = useState<DraftProvenance | null>(null);
  const provenanceRef = useRef(provenance);
  provenanceRef.current = provenance;
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
  const trainingOn = settings?.scopes.training === true;
  const trainingRef = useRef(trainingOn);
  trainingRef.current = trainingOn;
  /** A message about a workout: it carries a workout request, or text the app generated from one. */
  const isWorkoutQuestion = (p: PendingSend) => !!p.request || (p.generated?.length ?? 0) > 0;

  /* ---------------------------------------------------------- loading */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [d, p, cache, prov] = await Promise.all([
        kvGet<string>(AI_DRAFT_KEY, db).catch(() => undefined),
        kvGet<PendingSend | null>(AI_PENDING_KEY, db).catch(() => undefined),
        kvGet<AiChatMessage[]>(AI_HISTORY_CACHE_KEY, db).catch(() => undefined),
        kvGet<DraftProvenance | null>(AI_DRAFT_GENERATED_KEY, db).catch(() => undefined),
      ]);
      if (cancelled) return;
      const draftText = typeof d === 'string' ? d : '';
      setDraft(draftText);
      draftRef.current = draftText;
      // Provenance is only valid for the exact draft it was recorded with (and this account).
      const validProv = prov && prov.draft === draftText && Array.isArray(prov.generated) && (!prov.userId || prov.userId === userId) ? prov : null;
      setProvenance(validProv);
      provenanceRef.current = validProv;
      // A message left "sending" by a closed tab was never confirmed: offer Retry with the same id.
      // (A message written under another account is never offered here.)
      const mine = p && (!p.userId || p.userId === userId) ? p : null;
      setPending(mine ? (mine.status === 'sending' ? { ...mine, status: 'failed', error: 'ai.chat.notConfirmed' } : mine) : null);
      setLoaded(true);
      if (!online) {
        setHistory(cache ?? []);
        if (cache?.length) setHistoryNote('ai.chat.cachedHistory');
        return;
      }
      try {
        const h = await aiApi.history(100);
        if (cancelled) return;
        setHistory(h);
        setHistoryNote(null);
        void kvSet(AI_HISTORY_CACHE_KEY, h.slice(-100), db).catch(() => undefined);
        if (mine && h.some((m) => m.id === mine.id)) {
          setPending(null);
          void kvSet(AI_PENDING_KEY, null, db).catch(() => undefined);
        }
      } catch (e) {
        if (cancelled) return;
        setHistory(cache ?? []);
        setHistoryNote(cache?.length ? 'ai.chat.refreshFailed' : classifyAiError(e).key);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [db, online, userId]);

  const conversation = useMemo(() => mergeConversation(history ?? [], pending), [history, pending]);

  // Respect the reader's scroll position: follow new content only when they are at the bottom; otherwise offer
  // "Show latest reply".
  const atBottom = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onScroll = () => {
      const doc = document.documentElement;
      atBottom.current = window.innerHeight + window.scrollY >= doc.scrollHeight - 160;
      if (atBottom.current) setShowLatest(false);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  const toBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView?.({ block: 'end' });
    setShowLatest(false);
  }, []);
  useEffect(() => {
    if (atBottom.current) toBottom();
    else setShowLatest(true);
  }, [conversation.length, pending?.status, live?.preview, toBottom]);

  // "This is taking a little longer." once a reply has been on its way for a while (no artificial delays anywhere).
  const liveId = live?.id;
  useEffect(() => {
    if (!liveId) return;
    const t = setTimeout(() => setLive((l) => (l && l.id === liveId ? { ...l, slow: true } : l)), SLOW_AFTER_MS);
    return () => clearTimeout(t);
  }, [liveId]);

  /* ------------------------------------------------------------ draft */
  /** Replace the draft; `generated`: which parts of it the app generated (none: it's all the user's). */
  const setDraftWith = useCallback(
    (text: string, generated: TextRanges = [], sources: string[] = [], held = false) => {
      setDraft(text);
      draftRef.current = text;
      void kvSet(AI_DRAFT_KEY, text, db).catch(() => undefined);
      const prov: DraftProvenance | null = generated.length ? { draft: text, generated, sources, userId, ...(held ? { held: true } : {}) } : null;
      if (prov || provenanceRef.current) void kvSet(AI_DRAFT_GENERATED_KEY, prov, db).catch(() => undefined);
      setProvenance(prov);
      provenanceRef.current = prov;
    },
    [db, userId],
  );
  /** Programmatic replacement of the whole draft with text the user wrote (or chose). */
  const updateDraft = useCallback((text: string) => setDraftWith(text), [setDraftWith]);
  /** The user edited the draft: what they typed is theirs; generated parts they kept stay marked as generated. */
  const editDraft = useCallback(
    (text: string) => {
      const prov = provenanceRef.current;
      if (prov && prov.draft === draftRef.current) setDraftWith(text, trackDraftEdit(prov.draft, text, prov.generated, prov.sources), prov.sources, prov.held);
      else setDraftWith(text);
    },
    [setDraftWith],
  );

  const persistPending = useCallback(
    (p: PendingSend | null) => {
      setPending(p);
      void kvSet(AI_PENDING_KEY, p, db).catch(() => undefined);
    },
    [db],
  );

  /* ------------------------------------------------------------- send */
  const protocol = availability.available ? availability.protocol : undefined;
  const stopAllowed = canStop(aiApi, protocol);

  /** The authoritative exchange arrived: replace the preview through the normal mappers (deduplicated by id). */
  function finish(p: PendingSend, res: SendResult) {
    const userMsg: AiMessage = { id: p.id, role: 'user', content: p.text, createdAt: p.createdAt, status: 'sent' };
    setHistory((h) => {
      const next = upsertMessages(h ?? [], [userMsg, res.reply]);
      void kvSet(AI_HISTORY_CACHE_KEY, next.slice(-100), db).catch(() => undefined);
      return next;
    });
    if (res.proposal) setProposals((m) => ({ ...m, [res.proposal!.id]: res.proposal! }));
    persistPending(null);
    setLive(null);
    setAnnounce(t('ai.chat.replyReady'));
    // Only the kind of action and its outcome: never the message, the reply or any of their content. A replayed
    // (duplicate) exchange was already counted when it was first delivered.
    if (!res.duplicate) {
      void trackAiAction(db, p.mode === 'checkin_review' ? 'checkin_review' : 'chat_message', 'sent');
      if (res.proposal) void trackAiAction(db, 'program_proposal', 'proposed');
      const reply = res.reply;
      if (reply.weekPlan) void trackAiAction(db, 'week_plan', 'proposed');
      if (reply.sessionAdjustment) void trackAiAction(db, 'session_adjustment', 'proposed');
      if (reply.mealPlan) void trackAiAction(db, 'meal_plan', 'proposed');
    }
    // Usage comes from the server (authoritative); older servers don't send it, then count a new exchange once.
    if (res.usage && typeof res.usage.requests === 'number') setUsage(res.usage);
    else if (usage && !res.duplicate) setUsage({ requests: usage.requests + 1 });
  }

  /** A settled outcome (Stop, interrupted stream, status check) → the conversation. */
  function settle(p: PendingSend, r: Settled) {
    setLive(null);
    if (r.kind === 'finished') return finish(p, r.result);
    if (r.kind === 'stopped') {
      if (r.usage && typeof r.usage.requests === 'number') setUsage(r.usage);
      persistPending({ ...p, status: 'failed', error: 'ai.chat.replyStopped', stopped: true });
      setAnnounce(t('ai.chat.replyStopped'));
      return;
    }
    if (r.kind === 'blocked') return persistPending({ ...p, status: 'failed', error: TRAINING_OFF_PENDING });
    persistPending({ ...p, status: 'failed', error: r.kind === 'failed' ? 'ai.chat.replyInterrupted' : 'ai.chat.replyUnconfirmed' });
  }

  async function run(p: PendingSend) {
    const mine = owner.current;
    if (p.userId && p.userId !== mine.userId) return;
    // This send's own controller: Stop, leaving the chat and narrowed sharing abort it (reader, waits, sync).
    const ctrl = new AbortController();
    const onOwnerAbort = () => ctrl.abort();
    mine.ctrl.signal.addEventListener('abort', onOwnerAbort);
    const { signal } = ctrl;
    const stillMine = () => !mine.ctrl.signal.aborted && owner.current === mine;
    const active = () => stillMine() && !signal.aborted;
    const update = (f: (l: LiveReply) => LiveReply) => {
      if (active()) setLive((l) => (l && l.id === p.id ? f(l) : l));
    };
    // Every request for this message is bound to the account that wrote it (review P1-1).
    const flow = { expectedUserId: mine.userId };
    const workoutQuestion = isWorkoutQuestion(p);
    setSendError(null);
    // A workout question (it names exercises and targets) is never sent while Training isn't shared.
    if (workoutQuestion && !trainingRef.current) {
      persistPending({ ...p, status: 'failed', error: TRAINING_OFF_PENDING });
      return;
    }
    const sending: PendingSend = { ...p, userId: mine.userId, status: 'sending', error: undefined };
    persistPending(sending);
    setLive({ id: p.id, phase: 'syncing', preview: '', stopping: false, stopNote: null, slow: false, ctrl, workoutQuestion });
    let unsynced = 0;
    /**
     * The input for ONE attempt, rebuilt right before it goes out (first send, every in_progress retry, a recovery
     * replay): Training sharing is re-checked and the workout snapshot rebuilt from the device each time (review P1-2).
     */
    const prepare: Prepare = async () => {
      if (workoutQuestion && !trainingRef.current) return null;
      const workout = p.request ? (await prepareCoachRequest(db, p.request, exerciseByIdRef.current))?.workout : undefined;
      if (workoutQuestion && !trainingRef.current) return null; // switched off while the snapshot was built
      return { id: p.id, text: p.text, mode: p.mode, ...(unsynced ? { unsynced } : {}), ...(workout ? { workout } : {}) };
    };
    const blockedByTraining = () => {
      setLive(null);
      persistPending({ ...p, status: 'failed', error: TRAINING_OFF_PENDING });
    };
    try {
      // Sync barrier: push this device's pending changes first (bounded wait), so the coach doesn't act on stale data.
      unsynced = await syncBeforeAi(db);
      if (!active()) return; // stopped (the Stop handler settles it) or detached
      update((l) => ({ ...l, phase: 'preparing' }));
      // A replay of a message still being answered waits for that answer (same id) instead of failing. Streamed when the
      // server supports it; the preview is plain text of the finished, stored answer.
      const res = await sendReply(aiApi, protocol, prepare, {
        onPhase: (phase) => update((l) => ({ ...l, phase })),
        onText: (text) => update((l) => ({ ...l, phase: 'receiving', preview: l.preview + text })),
      }, signal, flow);
      if (!active()) return; // answered for the previous account: it's in that account's history (its Retry gets it back as a duplicate)
      finish(sending, res as SendResult);
    } catch (e) {
      if (!active() || isCancelled(e) || (e as Error)?.name === 'AbortError') return; // Stop / detach own the outcome
      const code = (e as { code?: unknown })?.code;
      if (code === 'account_changed') return; // another account is signed in now: nothing goes out under it
      if (code === 'training_not_shared') return blockedByTraining();
      if (code === 'request_cancelled') return settle(sending, { kind: 'stopped', usage: (e as { usage?: Partial<AiUsage> }).usage });
      if (code === 'stream_interrupted' || code === 'stream_protocol' || code === 'cancel_unconfirmed') {
        // EOF / stall without a terminal event: unconfirmed. Check the SAME id (never a second generation for a slow stream).
        update((l) => ({ ...l, phase: 'reconnecting', preview: '' }));
        try {
          const r = await recoverReply(aiApi, prepare, p.id, { ...flow, signal, statusSupported: stopAllowed, onWaiting: () => update((l) => ({ ...l, phase: 'waiting' })) });
          if (!active()) return;
          if (r.kind === 'blocked') return blockedByTraining();
          settle(sending, r);
        } catch {
          // detached, or the account changed meanwhile
        }
        return;
      }
      const c = classifyAiError(e);
      setSendError(c);
      setLive(null);
      persistPending({ ...p, status: 'failed', error: c.key });
      if (c.kind === 'rate_limited' && c.usage) setUsage(c.usage);
      if (c.kind === 'paused' || c.kind === 'disabled' || c.kind === 'unavailable') void reload();
    } finally {
      mine.ctrl.signal.removeEventListener('abort', onOwnerAbort);
    }
  }

  /** Stop: an acknowledged cancel. "Stopping…" until the server settles it; success may still win. */
  async function stop() {
    const l = liveRef.current;
    const p = pendingRef.current;
    if (!l || !p || l.stopping || !stopAllowed || p.id !== l.id) return;
    const mine = owner.current;
    setLive({ ...l, stopping: true });
    l.ctrl.abort(); // stop reading and waiting locally; the outcome comes from the server
    try {
      const r = await stopReply(aiApi, l.id, {
        signal: mine.ctrl.signal,
        expectedUserId: mine.userId,
        onUnconfirmed: () => setLive((x) => (x && x.id === l.id ? { ...x, stopNote: 'ai.chat.stopUnconfirmed' } : x)),
      });
      if (owner.current !== mine || mine.ctrl.signal.aborted) return;
      if (r.kind === 'finished') {
        toast.show(t('ai.chat.replyAlreadyFinished'), { tone: 'info' });
        setAnnounce(t('ai.chat.replyAlreadyFinished'));
      }
      settle({ ...p, status: 'sending' }, r);
    } catch {
      // detached (left the chat / switched account): the pending message stays, with its id
    }
  }

  // Training sharing narrowed while a workout question is in flight (review P1-2): stop that flow at once (no further
  // attempt goes out), keep the message on the device as not sendable, and ask the server to stop it too.
  useEffect(() => {
    if (trainingOn) return;
    const l = liveRef.current;
    const p = pendingRef.current;
    if (!l || !l.workoutQuestion || !p || p.id !== l.id) return;
    l.ctrl.abort();
    setLive(null);
    persistPending({ ...p, status: 'failed', error: TRAINING_OFF_PENDING });
    if (stopAllowed) void aiApi.cancel(l.id, { expectedUserId: owner.current.userId }).catch(() => undefined);
  }, [trainingOn]); // eslint-disable-line react-hooks/exhaustive-deps -- reacts to the sharing change only

  const canCompose = loaded && !pending;
  // A draft with generated workout detail in it can't be sent while Training isn't shared (it stays on the device).
  const draftHasGenerated = !!provenance && provenance.draft === draft && provenance.generated.length > 0;
  const draftBlocked = draftHasGenerated && !trainingOn;
  const canSend = canCompose && !blocked && !draftBlocked && draft.trim().length > 0;

  function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!canSend) return;
    // The attachment moves onto the pending message (stored on the device) until the send succeeds, and so does the
    // record of which parts of the text were generated.
    const generated = draftHasGenerated ? rangesAfterTrim(draft, provenance!.generated) : [];
    start(draft.trim(), 'chat', true, attachedActive?.req, generated);
    setAttachedReq(null);
  }
  /** `fromDraft`: the text came from the composer, so clear it (quick replies leave a typed draft alone). */
  function start(text: string, mode: AiMode, fromDraft = mode === 'chat', request?: CoachRequest, generated: TextRanges = []) {
    if (blocked) return;
    const p: PendingSend = {
      id: uuid(), text, mode, status: 'sending', createdAt: new Date().toISOString(), userId, ...(request ? { request } : {}), ...(generated.length ? { generated } : {}),
    };
    if (fromDraft) updateDraft('');
    void run(p);
  }

  /*
   * A contextual request from the workout screen or summary ("Short on time", "Equipment busy", "Explain this"): taken
   * once, after the conversation, any unconfirmed message and the settings are loaded. Only while Training is shared
   * (the visible message itself names exercises and targets): otherwise nothing is written or sent, and a notice says
   * why. Sent right away when possible; otherwise its text goes into the composer with the workout attached, and the
   * attachment is kept on this device until it's sent or removed.
   */
  const { byId: exerciseById } = useExercises();
  const exerciseByIdRef = useRef(exerciseById);
  exerciseByIdRef.current = exerciseById;
  const [attached, setAttached] = useState<{ req: CoachRequest; name: string; finished: boolean } | null>(null);
  const [trainingOffNotice, setTrainingOffNotice] = useState(false);
  /** Set or clear the deferred attachment (state + device storage). */
  const setAttachedReq = useCallback(
    (req: CoachRequest | null) => {
      void kvSet(AI_ATTACHED_REQUEST_KEY, req, db).catch(() => undefined);
      if (!req) return setAttached(null);
      void db.sessions.get(req.sessionId).then(
        (sess) => setAttached(sess && !sess.deletedAt ? { req, name: sess.name, finished: sess.status === 'completed' } : null),
        () => setAttached(null),
      );
    },
    [db],
  );
  // While Training isn't shared an attachment is neither shown nor sent.
  const attachedActive = trainingOn ? attached : null;
  const requestTaken = useRef(false);
  const ready = loaded && history !== undefined && settings !== undefined;
  useEffect(() => {
    if (!ready || requestTaken.current) return;
    requestTaken.current = true;
    void (async () => {
      const kept = await loadAttachedRequest(db, userId);
      if (kept && trainingOn) setAttachedReq(kept); // (with Training off, the effect below removes it and its text)
      const req = await takeCoachRequest(db, userId);
      if (!req) return;
      if (!trainingOn) {
        setTrainingOffNotice(true);
        return;
      }
      const prepared = await prepareCoachRequest(db, req, exerciseById);
      if (!prepared || owner.current.userId !== userId) return;
      if (!pending && !blocked) start(prepared.text, 'chat', false, req, [[0, prepared.text.length]]);
      else {
        // The generated text goes after anything the user had already written, and is remembered as generated (with
        // the attachment), so it can be removed again if sharing is turned off.
        const before = draftRef.current.trim() ? `${draftRef.current}\n` : '';
        const prov = provenanceRef.current && provenanceRef.current.draft === draftRef.current ? provenanceRef.current : null;
        setDraftWith(`${before}${prepared.text}`, [...(before ? prov?.generated ?? [] : []), [before.length, before.length + prepared.text.length]], [...(prov?.sources ?? []), prepared.text]);
        setAttachedReq({ ...req, text: prepared.text });
      }
    })();
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps -- once, when ready

  // Training sharing off (on open, or switched off while here): a waiting workout question goes — its attachment and
  // the text the app generated for it (that text names exercises and targets). What the user wrote stays.
  useEffect(() => {
    if (!ready || trainingOn) return;
    let cancelled = false;
    void (async () => {
      const kept = await loadAttachedRequest(db, userId);
      const d = draftRef.current;
      const prov = provenanceRef.current && provenanceRef.current.draft === d && provenanceRef.current.generated.length ? provenanceRef.current : null;
      if (cancelled || (!kept && !prov)) return;
      if (kept) setAttachedReq(null);
      if (prov?.held) {
        // Already held back (see below): nothing to remove.
      } else if (prov) {
        // Exactly the generated parts go, even after edits and in either language.
        setDraftWith(stripGenerated(d, prov.generated, prov.sources));
      } else if (kept?.text && d.includes(kept.text)) {
        setDraftWith(d.replace(kept.text, '').trim());
      } else if (kept?.text && d.trim()) {
        // Written by an older version without a record of what was generated, and edited since: it can't be split
        // safely, so it's kept on the device (the user's own words aren't lost) but can't be sent while Training is off.
        setDraftWith(d, [[0, d.length]], [kept.text], true);
      }
      setTrainingOffNotice(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, trainingOn]); // eslint-disable-line react-hooks/exhaustive-deps -- db/userId are stable for this screen

  /** The unconfirmed message is a workout question and Training isn't shared: it can't be retried, only removed. */
  const pendingBlocked = !!pending && isWorkoutQuestion(pending) && !trainingOn;
  function retry() {
    if (!pending || blocked) return;
    if (pendingBlocked) {
      persistPending({ ...pending, status: 'failed', error: TRAINING_OFF_PENDING });
      return;
    }
    // After a confirmed Stop the id is spent: sending it again is a deliberate new request (new id). Every other retry
    // (failed, interrupted, unconfirmed) keeps its id, so the server can return the stored reply instead of a second one.
    void run(pending.stopped ? { ...pending, id: uuid(), stopped: undefined, createdAt: new Date().toISOString() } : pending);
  }
  function removePending() {
    persistPending(null);
    setSendError(null);
  }
  function editPending() {
    if (!pending) return;
    if (pendingBlocked) return removePending(); // its text names exercises and targets: never put back to send
    // Back into the composer after anything typed meanwhile, keeping the record of what was generated.
    const before = draft ? `${draft}\n` : '';
    const prov = draftHasGenerated ? provenance! : null;
    const shifted: TextRanges = (pending.generated ?? []).map(([a, b]) => [a + before.length, b + before.length]);
    setDraftWith(`${before}${pending.text}`, [...(prov?.generated ?? []), ...shifted], [...(prov?.sources ?? []), ...(shifted.length ? [pending.text] : [])]);
    // Its workout attachment comes back with the text (it lived on the pending message until now).
    if (pending.request && trainingOn) setAttachedReq({ ...pending.request, text: pending.text });
    persistPending(null);
    setSendError(null);
    inputRef.current?.focus();
  }

  /* ------------------------------------------------------------- menu */
  async function setPaused(next: boolean) {
    setBusy('pause');
    try {
      setSettings(await aiApi.saveSettings({ paused: next }));
      toast.show(next ? t('ai.toast.paused') : t('ai.toast.resumed'), { tone: 'success' });
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
      toast.show(t('ai.history.cleared'), { tone: 'success' });
      setConfirmClear(false);
      setMenuOpen(false);
    } catch (e) {
      toast.show(classifyAiError(e).message, { tone: 'error' });
    } finally {
      setBusy(null);
    }
  }

  const menu = (
    <IconButton label={t('ai.chat.menu')} onClick={() => setMenuOpen(true)}>
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
            <span>{t('ai.chat.offline')}</span>
          </Notice>
        )}
        {!offline && providerDown && (
          <Notice tone="warn" className="flex gap-2 items-start">
            <AlertTriangle className="size-4 mt-0.5 shrink-0" aria-hidden />
            <div className="flex-1">
              <p>{availabilityCopy('provider_down').body}</p>
              <Button size="sm" className="mt-2" onClick={() => void reload()}>
                {t('ai.chat.checkAgain')}
              </Button>
            </div>
          </Notice>
        )}
        {paused && (
          <Notice tone="info" className="flex gap-2 items-center">
            <Pause className="size-4 shrink-0" aria-hidden />
            <span className="flex-1">{t('ai.chat.paused')}</span>
            <Button size="sm" variant="primary" loading={busy === 'pause'} onClick={() => void setPaused(false)}>
              {t('ai.resume')}
            </Button>
          </Notice>
        )}
        {(limitReached || sendError?.kind === 'rate_limited') && (
          <Notice tone="warn">{uLine ? t('ai.chat.dailyLimitUsage', { usage: uLine }) : t('ai.chat.dailyLimit')}</Notice>
        )}
        {historyNote && <Notice>{t(historyNote)}</Notice>}
        {trainingOffNotice && (
          <Notice className="flex gap-2 items-start">
            <span className="flex-1" role="status">
              {t('ai.chat.trainingOffNotice')}
            </span>
            <Button size="sm" onClick={() => nav('/coaching/ai/settings')}>
              {t('settings.title')}
            </Button>
          </Notice>
        )}
      </div>

      {/* conversation */}
      <div className="flex-1 px-3 py-3">
        {history === undefined ? (
          <Spinner label={t('ai.chat.loadingConversation')} />
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
                  <div className="flex flex-wrap gap-2 mb-4" role="group" aria-label={t('ai.chat.quickReplies')}>
                    {welcomeChips().map((c) => (
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
            <ol className="space-y-4" aria-label={t('ai.chat.conversation')}>
              {conversation.map((m) => (
                <MessageItem
                  key={m.id}
                  m={m}
                  week={{ program, sessions, activities, today, weekStart, db }}
                  pending={m.pending}
                  proposal={m.proposalId ? proposals[m.proposalId] : undefined}
                  coach={coach}
                  onShare={() => setShare({ key: m.id, text: extractOpenLinks(m.content, appFeatures()).text })}
                  onRetry={retry}
                  onEdit={editPending}
                  onRemove={removePending}
                  retryDisabled={blocked}
                  workoutBlocked={m.pending ? pendingBlocked : false}
                  sending={!!live && live.id === m.id}
                />
              ))}
              {live && live.preview && (
                // Transient preview of the finished answer: plain text, no links, cards or badges, not announced chunk by
                // chunk (the status line and the completion notice are).
                <li className="max-w-[92%]" data-testid="ai-reply-preview">
                  <div className="rounded-2xl rounded-tl-md bg-surface border border-line px-3.5 py-2.5 text-[15px] whitespace-pre-wrap break-words">
                    {previewText(live.preview)}
                  </div>
                </li>
              )}
            </ol>
          </>
        )}
        <div ref={bottomRef} />
      </div>

      {/* composer (embedded: just above the tab bar) */}
      <div className={cx('sticky bg-bg/95 backdrop-blur border-t border-line px-3 pt-2', embedded ? 'bottom-[calc(57px+env(safe-area-inset-bottom))] z-30' : 'bottom-0 pb-safe')}>
        <p className="sr-only" role="status" aria-live="polite" data-testid="ai-announce">
          {live ? '' : announce}
        </p>
        {showLatest && (
          <div className="flex justify-center pb-2">
            <Button size="sm" variant="secondary" icon={<ArrowDown className="size-4" aria-hidden />} onClick={toBottom}>
              {t('ai.chat.showLatest')}
            </Button>
          </div>
        )}
        {live && (
          <div className="flex items-center gap-2 pb-2 min-h-10" data-testid="ai-status-line">
            <Loader2 className="size-4 animate-spin text-accent shrink-0" aria-hidden />
            <p className="flex-1 min-w-0 text-sm text-muted" role="status" aria-live="polite">
              {live.stopping ? t('ai.chat.stoppingReply') : t(LIVE_KEY[live.phase])}
              {live.stopNote ? ` ${t(live.stopNote)}` : live.slow && !live.stopping ? ` ${t('ai.chat.status.slow')}` : ''}
            </p>
            {stopAllowed && (
              <Button size="sm" variant="outline" disabled={live.stopping} icon={<Square className="size-3.5" aria-hidden />} onClick={() => void stop()}>
                {live.stopping ? t('ai.chat.stoppingReply') : t('ai.chat.stopReply')}
              </Button>
            )}
          </div>
        )}
        {canCompose && draft.trim() === '' && !blocked && (
          <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1" role="group" aria-label={t('ai.chat.suggestedQuestions')}>
            <button
              type="button"
              onClick={() => start(checkinReviewText(), 'checkin_review')}
              className="shrink-0 min-h-10 px-3.5 rounded-full border border-accent/40 bg-accent-soft text-accent text-sm font-medium inline-flex items-center gap-1.5"
            >
              <ClipboardCheck className="size-4" aria-hidden /> {t('ai.chat.checkinReview')}
            </button>
            {suggestedQuestions().map((q) => (
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
        {attachedActive && (
          <div className="flex items-center gap-2 pb-2">
            <span className="inline-flex items-center gap-1.5 min-h-8 rounded-full bg-surface-2 border border-line px-3 text-xs" data-testid="ai-attached-workout">
              <Dumbbell className="size-3.5 text-accent" aria-hidden />
              {t(attachedActive.finished ? 'ai.chat.workoutAttached' : 'ai.chat.todayWorkoutAttached', { name: attachedActive.name })}
            </span>
            <IconButton size="sm" label={t('ai.chat.removeWorkout')} onClick={() => setAttachedReq(null)}>
              <X className="size-4" />
            </IconButton>
          </div>
        )}
        <form onSubmit={submit} className="flex items-end gap-2">
          <label htmlFor="ai-composer" className="sr-only">
            {t('ai.chat.composerLabel')}
          </label>
          <textarea
            id="ai-composer"
            ref={inputRef}
            value={draft}
            maxLength={AI_MESSAGE_MAX}
            disabled={!loaded}
            rows={Math.min(6, Math.max(1, draft.split('\n').length))}
            placeholder={pending ? t('ai.chat.waitingPlaceholder') : t('ai.chat.askPlaceholder')}
            onChange={(e) => editDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
            }}
            aria-describedby="ai-composer-hint"
            className="flex-1 min-h-11 max-h-40 rounded-xl bg-field border border-line-input px-3 py-2.5 text-[16px] text-ink placeholder:text-faint focus:border-accent resize-none"
          />
          <IconButton type="submit" label={t('ai.chat.send')} disabled={!canSend} className={cx(canSend && 'ember-fill')}>
            <SendHorizontal className="size-5" />
          </IconButton>
        </form>
        <p id="ai-composer-hint" className="text-[11px] text-faint mt-1 mb-1">
          {offline
            ? t('ai.chat.offlineHint')
            : paused
              ? t('ai.chat.pausedHint')
              : pending?.status === 'failed'
                ? t('ai.chat.pendingHint')
                : draftBlocked
                  ? t('ai.chat.trainingOffPending')
                  : uLine
                    ? t('ai.chat.adviceUsageHint', { usage: uLine })
                    : t('ai.chat.adviceHint')}
        </p>
      </div>

      <Sheet open={menuOpen} onClose={() => setMenuOpen(false)} title={t('ai.title')}>
        {uLine && <p className="text-sm text-muted mb-2">{uLine}</p>}
        <div className="-mx-5">
          <ListRow left={<Settings2 className="size-5 text-muted" />} title={t('settings.title')} subtitle={t('ai.chat.settingsMenuDescription')} onClick={() => nav('/coaching/ai/settings')} />
          <ListRow left={<Sparkles className="size-5 text-muted" />} title={t('ai.proposals.title')} subtitle={t('ai.chat.proposalsMenuDescription')} onClick={() => nav('/coaching/ai/proposals')} />
          <ListRow
            left={paused ? <Play className="size-5 text-muted" /> : <Pause className="size-5 text-muted" />}
            title={paused ? t('ai.chat.resume') : t('ai.chat.pause')}
            subtitle={paused ? t('ai.chat.resumeDescription') : t('ai.chat.pauseDescription')}
            onClick={() => (busy ? undefined : void setPaused(!paused))}
          />
          <ListRow left={<Trash2 className="size-5 text-danger" />} title={<span className="text-danger">{t('ai.history.clear')}</span>} subtitle={t('ai.chat.clearMenuDescription')} onClick={() => setConfirmClear(true)} />
        </div>
      </Sheet>

      <ConfirmDialog
        open={confirmClear}
        title={t('ai.history.clearConfirm.title')}
        danger
        confirmLabel={t('ai.history.clear')}
        busy={busy === 'clear'}
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => void clearHistory()}
        body={t('ai.chat.clearConfirmBody')}
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
  const { t } = useT();
  if (program === undefined || sessions === undefined) return null; // local data still loading (instant in practice)
  const style: CoachStyle = settings.coachStyle;
  const record = settings.scopes.training ? safeRecord(sessions, byId, unit, today) : null;
  const w = buildWelcome({ scopes: settings.scopes, goal, displayName, hour: localHour(timeZone), style, record, program, sessions, activities, today, weekStart });
  return (
    <article aria-label={t('ai.chat.welcomeLabel')} className="max-w-[92%] mb-4">
      <div className="flex items-center gap-2 mb-1">
        <span className="size-6 rounded-full bg-surface-3 flex items-center justify-center text-info" aria-hidden>
          <Bot className="size-3.5" />
        </span>
        <span className="text-sm font-semibold">{t('ai.title')}</span>
        <AiBadge />
      </div>
      <div className="rounded-2xl rounded-tl-md bg-surface border border-line px-3.5 py-2.5 text-[15px] space-y-1.5">
        <p className="font-medium">{w.greeting}</p>
        {w.lines.map((l, i) => (
          <p key={i}>{l}</p>
        ))}
        <p>{w.closing}</p>
      </div>
      <p className="mt-1 text-[11px] text-faint">{t('ai.chat.welcomeDisclaimer')}</p>
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
  m, week, pending, proposal, coach, onShare, onRetry, onEdit, onRemove, retryDisabled, workoutBlocked, sending = false,
}: {
  m: AiChatMessage;
  week: WeekCtx;
  pending?: PendingSend;
  proposal?: ProgramProposal;
  coach: CoachingRelationship | null;
  onShare: () => void;
  onRetry: () => void;
  onEdit: () => void;
  onRemove: () => void;
  retryDisabled: boolean;
  /** A workout question that can't be sent because Training isn't shared: Remove instead of Retry / Edit. */
  workoutBlocked?: boolean;
  /** The status line under the conversation is showing this message's progress (item 10). */
  sending?: boolean;
}) {
  const nav = useNavigate();
  const { t } = useT();
  if (m.role === 'user') {
    const reason = pendingErrorText(pending?.error);
    return (
      <li className="flex justify-end">
        <div className="max-w-[85%] flex flex-col items-end">
          <span className="sr-only">{t('ai.chat.you')}</span>
          <div className={cx('rounded-2xl rounded-br-md px-3.5 py-2.5 whitespace-pre-wrap break-words text-[15px]', pending?.status === 'failed' ? 'bg-surface-2 border border-danger/40' : 'bg-accent-soft border border-accent/30')}>
            {m.content}
          </div>
          {pending?.status === 'sending' && !sending && (
            <span className="text-xs text-muted mt-1" role="status">
              {t('ai.chat.sending')}
            </span>
          )}
          {pending?.status === 'failed' && workoutBlocked && (
            <div className="mt-1 flex flex-wrap items-center justify-end gap-1">
              <span className="text-xs text-danger">{t('ai.chat.notSentReason', { reason: t(TRAINING_OFF_PENDING) })}</span>
              <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={onRemove}>
                {t('ai.chat.remove')}
              </Button>
            </div>
          )}
          {pending?.status === 'failed' && !workoutBlocked && (
            <div className="mt-1 flex flex-wrap items-center justify-end gap-1">
              <span className="text-xs text-danger">
                {pending.error && REPLY_STATE_KEYS.has(pending.error) ? reason : reason ? t('ai.chat.notSentReason', { reason }) : t('ai.chat.notSent')}
              </span>
              <Button size="sm" variant="secondary" icon={<RotateCcw className="size-4" />} onClick={onRetry} disabled={retryDisabled}>
                {t('ai.chat.retry')}
              </Button>
              <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} onClick={onEdit}>
                {t('ai.chat.edit')}
              </Button>
            </div>
          )}
        </div>
      </li>
    );
  }
  // Dates in an Icelandic reply read Icelandic ("lau. 31. okt."), 1.0.3.
  const lang = detectLang(m.content) ?? 'en';
  const body = extractOpenLinks(humanizeDates(m.content, week.today, week.weekStart, lang), appFeatures());
  const whyText = m.why ? extractOpenLinks(humanizeDates(m.why, week.today, week.weekStart, lang), appFeatures()).text : '';
  return (
    <li>
      <article aria-label={t('ai.chat.messageLabel')} className="max-w-[92%]">
        <div className="flex items-center gap-2 mb-1">
          <span className="size-6 rounded-full bg-surface-3 flex items-center justify-center text-info" aria-hidden>
            <Bot className="size-3.5" />
          </span>
          <span className="text-sm font-semibold">{t('ai.title')}</span>
          <AiBadge />
        </div>
        <div className="rounded-2xl rounded-tl-md bg-surface border border-line px-3.5 py-2.5 text-[15px]" data-testid="ai-message-body">
          <Markdown text={body.text} />
        </div>
        {body.links.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-2" role="group" aria-label={t('ai.chat.openInApp')}>
            {body.links.map((l) => (
              <Button key={l.path} size="sm" variant="secondary" icon={<ArrowUpRight className="size-4" />} onClick={() => nav(l.path)}>
                {l.label}
              </Button>
            ))}
          </div>
        )}
        {whyText && (
          <details className="mt-1.5 group">
            <summary className="cursor-pointer select-none text-sm text-muted min-h-11 inline-flex items-center gap-1 hover:text-ink">{t('ai.chat.why')}</summary>
            <Markdown text={whyText} className="text-sm text-muted px-1 pb-1" />
          </details>
        )}
        {m.sessionAdjustment && <SessionAdjustmentCard action={m.sessionAdjustment} db={week.db} />}
        {m.weekPlan && (
          <WeekPlanCard plan={m.weekPlan} program={week.program} sessions={week.sessions} activities={week.activities} today={week.today} weekStart={week.weekStart} db={week.db} />
        )}
        {m.mealPlan && <MealPlanCard plan={m.mealPlan} />}
        {m.recipes && <RecipeCards suggestions={m.recipes} />}
        {m.grounding && m.grounding.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted">{t('ai.chat.basedOn')}</span>
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
                {proposal && !proposal.baseProgramId && proposal.target !== 'for_coach_review' ? t('ai.chat.addProgramReview') : t('ai.chat.changeProgramReview')}
              </span>
              <span className="block text-xs text-muted mt-0.5">
                {proposal
                  ? `${proposal.program.name}${proposal.changeSummary[0] ? ` · ${proposal.changeSummary[0]}` : ''}`
                  : t('ai.chat.proposalPlaceholder')}
              </span>
            </span>
          </Link>
        )}
        <div className="mt-1 flex items-center justify-between gap-2 flex-wrap">
          <p className="text-[11px] text-faint">{t('ai.chat.messageDisclaimer')}</p>
          {coach && <ShareButton onClick={onShare} />}
        </div>
      </article>
    </li>
  );
}

