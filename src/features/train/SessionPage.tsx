import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import clsx from 'clsx';
import {
  AlertTriangle, ArrowDown, ArrowUp, Bot, Check, ChevronDown, ChevronRight, CircleHelp, Info, Link2, Minus, MoreHorizontal, MoreVertical, Pause, Play, Plus, Repeat,
  SkipForward, StickyNote, Trash2, Timer, Undo2, RotateCcw, Wrench,
} from 'lucide-react';
import { useApp, useDb } from '@/state/app';
import { saveRecord, deleteRecord, alive } from '@/db/repo';
import { trackSetLogged, trackWorkoutCompleted } from '@/analytics/analytics';
import { useToast } from '@/components/toast';
import { Badge, Button, ConfirmDialog, EmptyState, IconButton, Input, Segmented, Sheet, Spinner, Textarea, Toggle } from '@/components/ui';
import type { CoachStyle, Exercise, Experience, ID, LoggedSet, SessionExercise, SetType, Settings, WeightUnit, WorkoutSession } from '@/domain/types';
import { useExercises } from '@/data/catalog';
import { ExercisePicker } from '@/components/ExercisePicker';
import { ExerciseIllustration, ExerciseThumb, hasIllustration } from '@/components/ExerciseVisual';
import { loadConventionNote } from '@/data/exerciseMeta';
import { displayWeight, fromKg, round, toKg } from '@/domain/units';
import { formatDuration } from '@/lib/dates';
import * as ops from '@/domain/sessionOps';
import { actionLabel, comparableHistory, incrementFor, lastPerformed, nextTargetLabel, suggestionReasonText, workingSets, type Suggestion } from '@/domain/progression';
import { usesLoad, validateLoggedSet, type SetField } from '@/domain/setValidation';
import { adaptPrescription, fitsConstraints, hasConstraints, substitutionCandidates } from '@/domain/substitution';
import { DraftNumberField, type CommitResult } from './DraftNumberField';
import { DraftRegistry, DraftRegistryContext, clearSessionDrafts, draftKey, formatNumber } from './setDraft';
import { useSubstitutionConstraints } from './hooks';
import { suggestionFor } from '@/domain/program/session';
import { beep, holdWakeLock, primeAudio, vibrate } from './feedback';
import { maybeAutoShare } from '@/social/autoShare';
import { cheerForSet, recordForSet, restOverCheer } from '@/domain/coachCheers';
import { celebrate } from '@/components/celebrate';
import type { ToastOptions } from '@/components/toast';
import { cancelRestPush, useRestPush } from '@/pwa/pushScheduler';
import { kvGet } from '@/db/repo';
import { openCoachWith, SHORT_ON_TIME_MINUTES, type CoachRequest } from '@/features/coaching/ai/workoutContext';
import { activeRecordFor, adjustRecordLines, AI_SESSION_ADJUST_KEY, revertAdjustment, type AdjustRecords } from '@/features/coaching/ai/sessionAdjustStore';
import { trackAiAction } from '@/analytics/analytics';
import { getLanguage, numberText, t as tNow, useT, type Language } from '@/i18n';

/**
 * Persist a change; resolves true when saved (or nothing needed saving), false when the device couldn't store it.
 * `fn` gets the latest stored record, after every earlier queued change; returning null writes nothing.
 */
type Mut = (fn: (s: WorkoutSession) => WorkoutSession | null) => Promise<boolean>;

/** Serialized, write-through editor: every change is persisted to IndexedDB in order. */
function useSessionEditor(id: string) {
  const db = useDb();
  const session = useLiveQuery(async () => (await db.sessions.get(id)) ?? null, [db, id]);
  const chain = useRef<Promise<boolean>>(Promise.resolve(true));
  const [saveError, setSaveError] = useState<null | { message: string; retry: () => void }>(null);
  const update: Mut = useCallback(
    (fn) => {
      const run = async () => {
        const cur = await db.sessions.get(id);
        if (!cur || cur.deletedAt || cur.status !== 'active') return true; // never edit a finished/discarded session from the logger
        const next = fn(cur);
        if (!next) return true; // nothing to write (e.g. Finish only opening the confirmation): keep any earlier save error and its Retry
        await saveRecord('sessions', next, db);
        setSaveError(null);
        return true;
      };
      chain.current = chain.current.then(run).catch(() => {
        // Keep the session and the typed drafts; show a persistent, retryable error. A raw storage error message is
        // neither shown nor translatable: the notice uses the approved copy.
        setSaveError({ message: tNow('workout.saveFailed'), retry: () => void update(fn) });
        return false;
      });
      return chain.current;
    },
    [db, id],
  );
  return { session, update, saveError };
}

function useNow(intervalMs: number, active = true) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    const vis = () => setNow(Date.now());
    document.addEventListener('visibilitychange', vis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', vis);
    };
  }, [intervalMs, active]);
  return now;
}

const enteredFor = (kg: number, unit: WeightUnit) => ({ value: round(fromKg(kg, unit), 2), unit });

/** Coach cheers are on unless the user switched them off (Settings → Workout, or the logger menu). */
export const cheersEnabled = (s: Settings) => s.workout.coachCheers !== false;

const REST_CHEER_KEY = 'lc-rest-cheer-shown';
function restCheerShown(key: string): boolean {
  try {
    return localStorage.getItem(REST_CHEER_KEY) === key;
  } catch {
    return false;
  }
}
function markRestCheer(key: string) {
  try {
    localStorage.setItem(REST_CHEER_KEY, key);
  } catch {
    /* storage blocked: the in-memory guard still prevents repeats while the page is open */
  }
}

/**
 * When the rest timer ends, a coach popup names the next set. Driven by the stored deadline (session.rest.endsAt),
 * so it is right after a reload or app switch. While the page is hidden nothing is shown; it appears once when the
 * user comes back. Each deadline is announced at most once (also across reloads).
 */
function useRestOverCheer(opts: {
  session: WorkoutSession | null | undefined;
  enabled: boolean;
  style: CoachStyle;
  byId: Map<ID, Exercise>;
  unit: WeightUnit;
  show: (message: string, o?: ToastOptions) => void;
  lastLine: React.MutableRefObject<string | null>;
}) {
  const latest = useRef(opts);
  latest.current = opts;
  const endsAt = opts.session?.status === 'active' ? opts.session.rest?.endsAt : undefined;
  const sessionId = opts.session?.id;
  useEffect(() => {
    if (!opts.enabled || endsAt == null || !sessionId) return;
    const key = `${sessionId}:${endsAt}`;
    let t: ReturnType<typeof setTimeout> | undefined;
    const fire = () => {
      const o = latest.current;
      const s = o.session;
      if (!s || s.rest?.endsAt !== endsAt) return;
      // A timer can fire a few ms before the wall-clock deadline (cached event-loop clock, busy main thread): try again
      // right after it instead of dropping the popup.
      if (Date.now() < endsAt) {
        clearTimeout(t);
        t = setTimeout(fire, endsAt - Date.now() + 1);
        return;
      }
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (restCheerShown(key)) return;
      markRestCheer(key);
      const cheer = restOverCheer(s, o.byId, o.unit, o.style, o.lastLine.current);
      if (!cheer) return;
      o.lastLine.current = cheer.line;
      o.show(cheer.line, { variant: 'coach' });
    };
    t = setTimeout(fire, Math.max(0, endsAt - Date.now()));
    document.addEventListener('visibilitychange', fire);
    return () => {
      clearTimeout(t);
      document.removeEventListener('visibilitychange', fire);
    };
  }, [opts.enabled, endsAt, sessionId]);
}

export default function SessionPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { db, account, updateAccount, auth, backendConfigured } = useApp();
  const { t, tp } = useT();
  const settings = account.settings;
  const cheers = cheersEnabled(settings);
  // Supportive is the default tone everywhere (the server's setting is mirrored here once the assistant loads).
  const coachStyle: CoachStyle = settings.coachStyle ?? 'supportive';
  // Contextual Coach entry points need the training assistant, i.e. a signed-in account on a configured backend.
  const aiEntry = backendConfigured && auth.status === 'signed_in';
  const [ask, setAsk] = useState<null | 'time' | 'swap' | 'explain'>(null);
  const adjustRecs = useLiveQuery(async () => (await kvGet<AdjustRecords>(AI_SESSION_ADJUST_KEY, db).catch(() => undefined)) ?? {}, [db]);
  const lastCheer = useRef<string | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const { session, update, saveError } = useSessionEditor(id);
  const { byId, get, list } = useExercises();
  useRestOverCheer({ session, enabled: cheers, style: coachStyle, byId, unit: settings.units.weight, show: toast.show, lastLine: lastCheer });
  useRestPush(session, byId, settings.units.weight);
  const constraints = useSubstitutionConstraints();
  const registry = useMemo(() => new DraftRegistry(), []);
  const history = useLiveQuery(async () => alive(await db.sessions.where('status').equals('completed').toArray()).sort((a, b) => b.startedAt - a.startedAt), [db]);
  const now = useNow(1000, !!session && session.status === 'active');
  const [picker, setPicker] = useState<null | { mode: 'add' } | { mode: 'swap'; exId: string; suggest: string[] }>(null);
  const [finishOpen, setFinishOpen] = useState(false);
  /** A tap on the header's Finish is being handled: ignores repeated taps. */
  const finishing = useRef(false);
  /** The post-finish steps (auto-share, navigation) ran: never run them twice. */
  const finishedOnce = useRef(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);

  useEffect(() => {
    if (!settings.rest.keepAwake || session?.status !== 'active') return;
    return holdWakeLock();
  }, [settings.rest.keepAwake, session?.status]);

  // Typed values are saved after a short debounce; also flush them whenever the page is hidden,
  // backgrounded or unloaded (local drafts cover the case where the write can't finish in time).
  useEffect(() => {
    const flush = () => void registry.flushAll();
    const vis = () => document.visibilityState === 'hidden' && flush();
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      document.removeEventListener('visibilitychange', vis);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
    };
  }, [registry]);

  if (session === undefined || history === undefined) return <Spinner label={t('workout.opening')} />;
  if (session === null || session.deletedAt)
    return <EmptyState title={t('workout.notFound')} body={t('workout.notFoundBody')} action={<Button onClick={() => nav('/train')}>{t('workout.goToTrain')}</Button>} />;
  if (session.status === 'completed') {
    return <EmptyState title={t('workout.finished')} action={<Button onClick={() => nav(`/train/history/${session.id}`, { replace: true })}>{t('workout.view')}</Button>} />;
  }

  const paused = !!session.pausedAt;
  const done = ops.completedSetCount(session);
  const total = session.exercises.reduce((n, e) => n + e.sets.length, 0);

  const onComplete = (se: SessionExercise, set: LoggedSet, showErrors: (e: Partial<Record<SetField, string>> | null) => void) => {
    primeAudio();
    const ex = get(se.exerciseId);
    // Hand any typed-but-not-yet-saved values to the queue first so completion uses them.
    const pending = registry.flushAll(set.id);
    if (pending.invalid.length) {
      toast.show(pending.invalid[0].reason, { tone: 'warn' });
      return;
    }
    let outcome: 'invalid' | 'done' | 'undone' | null = null;
    let fieldErrors: Partial<Record<SetField, string>> = {};
    let firstError = '';
    void update((s) => {
      const curEx = s.exercises.find((e) => e.id === se.id);
      const cur = curEx?.sets.find((x) => x.id === set.id);
      if (!curEx || !cur) return s;
      if (!cur.completed) {
        const v = validateLoggedSet(cur, ex, { mode: 'log', asCompleted: true });
        if (!v.ok) {
          outcome = 'invalid';
          fieldErrors = v.fieldErrors;
          firstError = v.errors[0];
          return s; // invalid sets are not completed, don't start rest and aren't copied forward
        }
      }
      const { session: next, completed } = ops.toggleSetComplete(s, se.id, set.id, Date.now(), ex);
      outcome = completed ? 'done' : 'undone';
      if (completed && settings.rest.autoStart && cur.type !== 'warmup') {
        const restSec = curEx.prescription?.restSec ?? settings.rest.defaultSec;
        // In a superset, rest after the last exercise of the group only.
        const idx = s.exercises.findIndex((e) => e.id === se.id);
        const nextEx = s.exercises[idx + 1];
        const midSuperset = curEx.supersetGroup && nextEx?.supersetGroup === curEx.supersetGroup;
        if (!midSuperset && restSec > 0) return ops.startRest(next, Date.now(), restSec * 1000, se.id);
      }
      if (!completed && s.rest?.forExerciseId === se.id) return ops.skipRest(next);
      return next;
    }).then((saved) => {
      if (!saved) return;
      if (outcome === 'invalid') {
        showErrors(fieldErrors);
        toast.show(firstError || t('workout.checkSet'), { tone: 'warn' });
        return;
      }
      showErrors(null);
      if (outcome !== 'done') return; // undo: quiet
      if (set.type !== 'warmup') void trackSetLogged(db, session.id); // first_set_logged milestone: no set data is recorded
      // A new personal record gets one brief celebration (Settings → Celebrations; never with reduced motion).
      if (settings.workout.celebrations !== false) {
        void db.sessions.get(session.id).then((latest) => {
          if (latest && recordForSet(latest, se.id, set.id, history ?? [], byId, settings.units.weight)) celebrate();
        });
      }
      const undo = { label: t('workout.undo'), onClick: () => void update((s) => ops.skipRest(ops.toggleSetComplete(s, se.id, set.id, Date.now()).session)) };
      if (!cheers) {
        toast.show(t('workout.setLogged'), { action: undo, duration: 3000 });
        return;
      }
      void db.sessions.get(session.id).then((latest) => {
        const cheer = latest ? cheerForSet({ session: latest, seId: se.id, setId: set.id, style: coachStyle, history: history ?? [], byId, unit: settings.units.weight, last: lastCheer.current }) : null;
        if (!cheer) {
          toast.show(t('workout.setLogged'), { action: undo, duration: 3000 }); // warm-up: no coach popup
          return;
        }
        lastCheer.current = cheer.line;
        toast.show(cheer.line, { variant: 'coach', action: undo });
      });
    });
  };

  /** After the session is stored as completed: clean up, auto-share once, open the summary. */
  const afterFinish = (finished: WorkoutSession) => {
    if (finishedOnce.current) return;
    finishedOnce.current = true;
    setFinishOpen(false);
    clearSessionDrafts(finished.id);
    cancelRestPush(auth.status === 'signed_in' ? auth.userId : null, finished.id);
    void trackWorkoutCompleted(db, finished.id); // first workout / second within 7 days: no workout data is recorded
    void maybeAutoShare({ session: finished }, { db, settings, byId }).then((shared) => {
      if (shared) toast.show(t('workout.queuedToShare'), { tone: 'success' });
    });
    nav(`/train/summary/${finished.id}`, { replace: true });
  };
  const readFinished = async () => {
    const finished = await db.sessions.get(session.id);
    if (finished?.status === 'completed') return finished;
    toast.show(t('workout.finishSaveFailed'), { tone: 'error' });
    return null;
  };

  /** From the confirmation sheet: deliberately sets the notes typed there. */
  const finish = async (notes: string) => {
    registry.flushAll();
    // Go through the same queue so set completions still being saved are included.
    await update((s) => ops.finishSession({ ...s, notes: notes || undefined }, Date.now()));
    const finished = await readFinished();
    if (finished) afterFinish(finished);
  };

  /**
   * Header Finish. Decided inside the edit queue against the latest stored record (after any pending note save, undo
   * or Add set), never the rendered one: if every working set is done, finish straight away and leave the stored
   * notes untouched; otherwise (unticked sets, nothing done, empty) open the confirmation sheet.
   */
  const onFinishTap = async () => {
    if (finishing.current || finishedOnce.current) return;
    finishing.current = true;
    try {
      registry.flushAll();
      let direct = false;
      const saved = await update((s) => {
        direct = ops.allWorkingSetsDone(s);
        return direct ? ops.finishSession(s, Date.now()) : null;
      });
      if (!direct) {
        if (saved) setFinishOpen(true);
        return;
      }
      const finished = await readFinished();
      if (finished) afterFinish(finished);
    } finally {
      finishing.current = false;
    }
  };

  const fitsUser = constraints && hasConstraints(constraints) ? (e: Exercise) => fitsConstraints(e, constraints) : undefined;

  /** Open the Coach with this workout attached. Typed values are saved first, so the coach sees them. */
  const askCoach = async (req: Omit<CoachRequest, 'createdAt' | 'sessionId' | 'userId'>) => {
    setAsk(null);
    registry.flushAll();
    await update(() => null); // waits for every queued save
    await openCoachWith(db, nav, { ...req, sessionId: session.id, userId: auth.userId });
  };
  const applied = activeRecordFor(adjustRecs, session.id);
  const undoApplied = async () => {
    if (!applied) return;
    registry.flushAll();
    const r = await revertAdjustment(db, applied.actionId, update);
    if (!r.ok) toast.show(r.reason, { tone: 'warn' });
    else {
      void trackAiAction(db, 'session_adjustment', 'reverted');
      toast.show(t('workout.adjustmentUndone'));
    }
  };
  const appliedLines = applied ? adjustRecordLines(applied) : [];
  const withSetsLeft = session.exercises.filter((e) => e.sets.some((x) => !x.completed && x.type !== 'warmup'));

  return (
    <DraftRegistryContext.Provider value={registry}>
    <div className="min-h-dvh pb-[calc(160px+env(safe-area-inset-bottom))]">
      <header className="sticky top-0 z-30 bg-bg/95 backdrop-blur border-b border-line pt-safe">
        <div className="mx-auto max-w-2xl flex items-center gap-1 px-2 min-h-14">
          <IconButton label={t('workout.minimise')} onClick={() => (registry.flushAll(), nav('/train'))}>
            <ChevronDown className="size-6" />
          </IconButton>
          <button className="flex-1 min-w-0 min-h-11 text-left px-1" onClick={() => setRenameOpen(true)} aria-label={t('workout.nameAria', { name: session.name })}>
            <div className="font-semibold truncate">{session.name}</div>
            <div className="text-xs text-muted tabular">
              {paused ? t('workout.paused') : formatDuration(ops.elapsedMs(session, now) / 1000)} · {t('workout.setProgress', { done, total })}
            </div>
          </button>
          <IconButton label={t('workout.options')} onClick={() => setOptionsOpen(true)}>
            <MoreVertical className="size-5" />
          </IconButton>
          <IconButton label={paused ? t('workout.resumeWorkout') : t('workout.pauseWorkout')} onClick={() => void update((s) => (s.pausedAt ? ops.resumeSession(s, Date.now()) : ops.pauseSession(s, Date.now())))}>
            {paused ? <Play className="size-5" /> : <Pause className="size-5" />}
          </IconButton>
          <Button variant="primary" size="sm" onClick={onFinishTap}>
            {t('workout.finish')}
          </Button>
        </div>
      </header>

      <div className="mx-auto max-w-2xl px-3 pt-3 space-y-3">
        {saveError && (
          <div role="alert" className="rounded-xl bg-danger-soft border border-danger/30 px-4 py-3 text-sm flex items-center gap-3">
            <AlertTriangle className="size-4 text-danger shrink-0" aria-hidden />
            <span className="flex-1">{t('workout.saveErrorNotice')}</span>
            <Button size="sm" onClick={saveError.retry}>
              {t('workout.retry')}
            </Button>
          </div>
        )}
        {paused && (
          <div className="rounded-xl bg-warn-soft border border-warn/30 px-4 py-3 text-sm flex items-center gap-3">
            <Pause className="size-4 text-warn" aria-hidden />
            <span className="flex-1">{t('workout.pausedNotice')}</span>
            <Button size="sm" onClick={() => void update((s) => ops.resumeSession(s, Date.now()))}>
              {t('workout.resume')}
            </Button>
          </div>
        )}
        {applied && (
          <div role="status" className="rounded-xl bg-accent-soft border border-accent/40 px-4 py-3 text-sm flex items-center gap-3">
            <Bot className="size-4 text-accent shrink-0" aria-hidden />
            <span className="flex-1">
              {appliedLines.length ? t('workout.adjustmentBannerWithChanges', { changes: appliedLines.join(', ') }) : t('workout.adjustmentBanner')}
            </span>
            <Button size="sm" variant="ghost" icon={<Undo2 className="size-4" />} onClick={() => void undoApplied()}>
              {t('workout.undo')}
            </Button>
          </div>
        )}
        {aiEntry && session.exercises.length > 0 && (
          <div role="group" aria-label={t('workout.askCoachAria')} className="flex items-center gap-2 overflow-x-auto -mx-1 px-1">
            <span className="shrink-0 text-xs text-muted inline-flex items-center gap-1">
              <Bot className="size-3.5" aria-hidden /> {t('workout.askCoach')}
            </span>
            <AskChip icon={<Timer className="size-4" aria-hidden />} label={t('workout.shortOnTime')} onClick={() => setAsk('time')} disabled={!withSetsLeft.length} />
            <AskChip icon={<Wrench className="size-4" aria-hidden />} label={t('workout.equipmentBusy')} onClick={() => setAsk('swap')} disabled={!withSetsLeft.length} />
            <AskChip icon={<CircleHelp className="size-4" aria-hidden />} label={t('workout.explainThis')} onClick={() => setAsk('explain')} />
          </div>
        )}
        {session.exercises.length === 0 && (
          <EmptyState icon={<Plus className="size-6" />} title={t('workout.firstExercise')} body={t('workout.firstExerciseBody')} action={<Button variant="primary" onClick={() => setPicker({ mode: 'add' })}>{t('workout.addExercise')}</Button>} />
        )}
        {session.exercises.map((se, i) => (
          <ExerciseBlock
            key={se.id}
            se={se}
            ex={get(se.exerciseId)}
            index={i}
            count={session.exercises.length}
            nextInSuperset={!!se.supersetGroup && session.exercises[i + 1]?.supersetGroup === se.supersetGroup}
            prevInSuperset={!!se.supersetGroup && session.exercises[i - 1]?.supersetGroup === se.supersetGroup}
            history={history}
            settings={settings}
            experience={account.profile.experience}
            update={update}
            sessionId={session.id}
            onComplete={(set, showErrors) => onComplete(se, set, showErrors)}
            onSwap={() => {
              const from = get(se.exerciseId);
              setPicker({ mode: 'swap', exId: se.id, suggest: from ? substitutionCandidates(from, list, constraints) : [] });
            }}
            onAsk={aiEntry ? (intent, shownTarget) => void askCoach({ intent, focusId: se.id, ...(shownTarget ? { shownTarget } : {}) }) : undefined}
          />
        ))}
        {session.exercises.length > 0 && (
          <div className="grid grid-cols-2 gap-2 pt-1">
            <Button icon={<Plus className="size-4" />} onClick={() => setPicker({ mode: 'add' })}>
              {t('workout.addExercise')}
            </Button>
            <Button icon={<StickyNote className="size-4" />} onClick={() => setNotesOpen(true)}>
              {session.notes ? t('workout.editNotes') : t('workout.notes')}
            </Button>
          </div>
        )}
        <div className="flex justify-center pt-4">
          <Button variant="ghost" className="text-danger" icon={<Trash2 className="size-4" />} onClick={() => setDiscardOpen(true)}>
            {t('workout.discardWorkout')}
          </Button>
        </div>
      </div>

      <RestBar session={session} settings={settings} update={update} now={now} />

      <ExercisePicker
        open={!!picker}
        onClose={() => setPicker(null)}
        title={picker?.mode === 'swap' ? t('workout.swapExercise') : t('workout.addExercise')}
        suggestIds={picker?.mode === 'swap' ? picker.suggest : undefined}
        fits={picker?.mode === 'swap' ? fitsUser : undefined}
        fitsNote={t('workout.fitsConstraints')}
        onPick={(ex) => {
          const p = picker;
          setPicker(null);
          if (!p) return;
          registry.flushAll();
          if (p.mode === 'add') void update((s) => ops.addExercise(s, ex, settings.workout.defaultSets));
          else
            void update((s) => {
              const cur = s.exercises.find((e) => e.id === p.exId);
              const from = cur ? get(cur.exerciseId) : undefined;
              if (cur?.sets.some((x) => x.completed)) {
                toast.show(tNow('workout.completedSetsStay'), { tone: 'info' });
                const rx = adaptPrescription(cur.prescription, from, ex);
                const left = Math.max(1, cur.sets.filter((x) => !x.completed && x.type !== 'warmup').length);
                return ops.addExercise(s, ex, left, rx ? { ...rx, sets: left } : undefined);
              }
              // Rebuild prescription, set fields, load convention and warm-ups for the new tracking type.
              return ops.swapExercise(s, p.exId, ex, from);
            });
        }}
      />

      <Sheet open={optionsOpen} onClose={() => setOptionsOpen(false)} title={t('workout.options')}>
        <div className="px-1">
          <Toggle
            label={t('workout.cheersSetting')}
            description={t('workout.cheersDescription')}
            checked={cheers}
            onChange={(v) => void updateAccount((a) => ({ ...a, settings: { ...a.settings, workout: { ...a.settings.workout, coachCheers: v } } }))}
          />
        </div>
      </Sheet>

      <Sheet open={ask === 'time'} onClose={() => setAsk(null)} title={t('workout.timeLeftQuestion')}>
        <p className="text-sm text-muted mb-3">{t('workout.shortenExplanation')}</p>
        <div className="grid grid-cols-3 gap-2" role="group" aria-label={t('workout.minutesLeft')}>
          {SHORT_ON_TIME_MINUTES.map((m) => (
            <Button key={m} onClick={() => void askCoach({ intent: 'shorten', minutes: m })}>
              {t('workout.minutesChoice', { minutes: m })}
            </Button>
          ))}
        </div>
      </Sheet>
      <Sheet open={ask === 'swap'} onClose={() => setAsk(null)} title={t('workout.whichEquipmentBusy')}>
        <p className="text-sm text-muted mb-2">{t('workout.swapTodayExplanation')}</p>
        <div className="flex flex-col -mx-1">
          {withSetsLeft.map((se) => (
            <MenuItem key={se.id} icon={<Wrench className="size-5 text-muted" />} label={get(se.exerciseId)?.name ?? t('workout.exerciseFallback')} trailing={<ChevronRight className="size-4 text-faint" />} onClick={() => void askCoach({ intent: 'swap', focusId: se.id })} />
          ))}
        </div>
      </Sheet>
      <Sheet open={ask === 'explain'} onClose={() => setAsk(null)} title={t('workout.whatToExplain')}>
        <div className="flex flex-col -mx-1">
          {session.exercises.map((se) => {
            const ex = get(se.exerciseId);
            const shown = ex ? shownTargetFor(se, ex, history, settings, account.profile.experience) : undefined;
            return (
              <MenuItem
                key={se.id}
                icon={<CircleHelp className="size-5 text-muted" />}
                label={ex?.name ?? t('workout.exerciseFallback')}
                sub={shown}
                trailing={<ChevronRight className="size-4 text-faint" />}
                onClick={() => void askCoach({ intent: 'explain', focusId: se.id, ...(shown ? { shownTarget: shown } : {}) })}
              />
            );
          })}
        </div>
      </Sheet>

      <FinishSheet open={finishOpen} session={session} onClose={() => setFinishOpen(false)} onFinish={finish} />

      <ConfirmDialog
        open={discardOpen}
        danger
        title={t('workout.discardConfirm')}
        body={done > 0 ? tp('workout.discardCompleted', done) : t('workout.nothingLogged')}
        confirmLabel={t('workout.discard')}
        onCancel={() => setDiscardOpen(false)}
        onConfirm={async () => {
          await deleteRecord('sessions', session.id, db);
          clearSessionDrafts(session.id);
          cancelRestPush(auth.status === 'signed_in' ? auth.userId : null, session.id);
          setDiscardOpen(false);
          nav('/train', { replace: true });
        }}
      />
      <TextSheet open={renameOpen} title={t('workout.name')} value={session.name} onClose={() => setRenameOpen(false)} onSave={(v) => void update((s) => ({ ...s, name: v.trim() || s.name }))} />
      <TextSheet open={notesOpen} title={t('workout.notes')} multiline value={session.notes ?? ''} onClose={() => setNotesOpen(false)} onSave={(v) => void update((s) => ({ ...s, notes: v.trim() || undefined }))} />
    </div>
    </DraftRegistryContext.Provider>
  );
}

/* ================================================================ Exercise */
type FieldErrors = Partial<Record<SetField, string>>;

function ExerciseBlock(props: {
  se: SessionExercise;
  ex: Exercise | undefined;
  index: number;
  count: number;
  nextInSuperset: boolean;
  prevInSuperset: boolean;
  history: WorkoutSession[];
  settings: Settings;
  experience?: Experience;
  update: Mut;
  sessionId: string;
  onComplete: (set: LoggedSet, showErrors: (e: FieldErrors | null) => void) => void;
  onSwap: () => void;
  /** Ask the training assistant about this exercise (contextual entry points); absent without the assistant. */
  onAsk?: (intent: 'swap' | 'explain', shownTarget?: string) => void;
}) {
  const { se, ex, settings, update, history, experience } = props;
  const { t } = useT();
  const unit = settings.units.weight;
  const [menu, setMenu] = useState(false);
  const [notes, setNotes] = useState(false);
  const [setMenuFor, setSetMenuFor] = useState<LoggedSet | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [showVisual, setShowVisual] = useState(false);
  const [rowErrors, setRowErrors] = useState<Record<string, FieldErrors>>({});
  const sectionRef = useRef<HTMLElement>(null);
  const last = useMemo(() => lastPerformed(comparableHistory(history, se.exerciseId), ex), [history, se.exerciseId, ex]);
  const lastWorking = last ? workingSets(last, ex) : [];
  const suggestion: Suggestion | null = useMemo(() => {
    if (!ex || !se.prescription) return null;
    return suggestionFor({ exerciseId: se.exerciseId, ...se.prescription }, ex, history, settings, experience).suggestion;
  }, [ex, se.prescription, se.exerciseId, history, settings, experience]);
  const note = ex ? loadConventionNote(ex) : null;
  const incUnit = ex ? incrementFor(ex, unit) : unit === 'kg' ? 2.5 : 5;
  const inc = toKg(incUnit, unit);
  const showLoad = usesLoad(ex);
  let normalIdx = 0;
  const rx = se.prescription;
  const nextPendingId = se.sets.find((x) => !x.completed)?.id;
  const timedRx = !!rx?.durationSec && (ex?.tracking === 'duration' || ex?.tracking === 'distance_time');

  /** Change a set. Completed sets are re-validated so a correction can't turn them into invalid work. */
  const changeSet = (set: LoggedSet, patch: Partial<LoggedSet>): CommitResult => {
    if (set.completed) {
      const v = validateLoggedSet({ ...set, ...patch }, ex, { mode: 'log', asCompleted: true });
      if (!v.ok) return v.errors[0];
    }
    if (rowErrors[set.id]) setRowErrors(({ [set.id]: _drop, ...rest }) => (void _drop, rest));
    return update((s) => ops.updateSet(s, se.id, set.id, patch));
  };

  return (
    <section ref={sectionRef} aria-labelledby={`ex-${se.id}`} className={clsx('rounded-2xl bg-surface border border-line', props.prevInSuperset && '-mt-1 rounded-t-md border-t-0', props.nextInSuperset && 'rounded-b-md')}>
      <div className="flex items-start gap-2 px-4 pt-3">
        {ex &&
          (hasIllustration(ex) ? (
            <button
              type="button"
              className="pressable mt-0.5 flex shrink-0 rounded-xl"
              aria-expanded={showVisual}
              aria-controls={`vis-${se.id}`}
              aria-label={t(showVisual ? 'exercise.visual.hide' : 'exercise.visual.show', { exercise: ex.name })}
              onClick={() => setShowVisual((v) => !v)}
              data-testid="exercise-thumb"
            >
              <ExerciseThumb ex={ex} className={showVisual ? 'ring-2 ring-accent' : undefined} />
            </button>
          ) : (
            <span className="mt-0.5 flex shrink-0" aria-hidden>
              <ExerciseThumb ex={ex} />
            </span>
          ))}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {se.supersetGroup && (props.nextInSuperset || props.prevInSuperset) && (
              <Badge tone="info">
                <Link2 className="size-3" aria-hidden /> {t('workout.superset')}
              </Badge>
            )}
            {se.discomfort && (
              <Badge tone="warn">
                <AlertTriangle className="size-3" aria-hidden /> {t('workout.discomfortNoted')}
              </Badge>
            )}
          </div>
          <h2 id={`ex-${se.id}`} className="text-[17px] font-semibold leading-tight mt-0.5">
            {ex ? (
              <Link to={`/train/exercises/${ex.id}`} className="hover:underline">
                {ex.name}
              </Link>
            ) : (
              t('workout.unknownExercise')
            )}
          </h2>
          <p className="text-xs text-muted mt-0.5">
            {rx
              ? timedRx
                ? t('workout.prescriptionTimed', { sets: rx.sets, seconds: rx.durationSec ?? 0, rest: formatDuration(rx.restSec) })
                : t('workout.prescriptionReps', { sets: rx.sets, reps: rx.repMin === rx.repMax ? rx.repMin : `${rx.repMin}–${rx.repMax}`, rir: rx.targetRir, rest: formatDuration(rx.restSec) })
              : t('workout.freeLogging')}
          </p>
          {note && <p className="text-xs text-faint mt-0.5">{note}</p>}
        </div>
        <IconButton label={t('workout.exerciseOptions', { exercise: ex?.name ?? t('workout.exerciseFallback') })} onClick={() => setMenu(true)}>
          <MoreHorizontal className="size-5" />
        </IconButton>
      </div>

      {showVisual && ex && (
        <div id={`vis-${se.id}`} className="px-4 pt-3">
          <ExerciseIllustration ex={ex} compact />
        </div>
      )}

      {lastWorking.length > 0 && ex && (
        <p className="px-4 mt-1 text-xs text-muted">{t('workout.lastTime', { sets: lastWorking.map((st) => compactSet(st, ex, unit)).join(', ') })}</p>
      )}
      {suggestion && ex && suggestion.action !== 'hold' && (
        <ProgressionCard
          key={`${se.exerciseId}:${suggestion.action}`}
          suggestion={suggestion}
          se={se}
          ex={ex}
          unit={unit}
          targetRir={rx?.targetRir}
          lastWorking={lastWorking}
          update={update}
          onSwap={props.onSwap}
          onCustomize={() => sectionRef.current?.querySelector<HTMLInputElement>('[data-set-pending="true"] input')?.focus()}
          onExplain={props.onAsk ? () => props.onAsk!('explain', shownTarget(suggestion, ex, unit)) : undefined}
        />
      )}

      <div role="table" aria-label={t('workout.setsFor', { exercise: ex?.name ?? t('workout.exerciseFallback') })} className="px-2 pt-2 pb-1">
        <div role="row" className="flex items-center gap-1.5 px-1 text-[11px] uppercase tracking-wide text-faint">
          <span role="columnheader" className="w-11 text-center">{t('workout.set')}</span>
          {showLoad && (
            <span role="columnheader" className="flex-1 text-center">
              {ex?.tracking === 'assisted' ? t('workout.assistanceUnit', { unit }) : ex?.tracking === 'bodyweight_plus' ? `+${unit}` : unit}
            </span>
          )}
          {ex?.tracking === 'distance_time' && <span role="columnheader" className="flex-1 text-center">{t('workout.metres')}</span>}
          {ex?.tracking === 'duration' || ex?.tracking === 'distance_time' ? (
            <span role="columnheader" className="flex-1 text-center">{t('workout.seconds')}</span>
          ) : (
            <span role="columnheader" className="flex-1 text-center">{ex?.unilateral ? t('workout.repsPerSide') : t('workout.reps')}</span>
          )}
          {settings.workout.showRir && ex?.tracking !== 'duration' && <span role="columnheader" className="w-14 text-center">{t('workout.rir')}</span>}
          <span role="columnheader" className="w-12 text-center">
            <span className="sr-only">{t('workout.done')}</span>
            <Check className="size-3.5 inline" aria-hidden />
          </span>
        </div>
        {se.sets.map((set) => {
          if (set.type !== 'warmup') normalIdx++;
          const prev = set.type === 'warmup' ? undefined : lastWorking[normalIdx - 1];
          return (
            <SetRow
              key={set.id}
              set={set}
              sessionId={props.sessionId}
              label={set.type === 'warmup' ? t('workout.warmupMarker') : set.type === 'drop' ? t('workout.dropMarker') : set.type === 'timed' ? t('workout.timedMarker', { index: normalIdx }) : String(normalIdx)}
              ex={ex}
              unit={unit}
              showLoad={showLoad}
              showRir={settings.workout.showRir}
              prev={prev}
              isNext={set.id === nextPendingId}
              errors={rowErrors[set.id]}
              repHint={rx && !timedRx ? (rx.repMin === rx.repMax ? String(rx.repMin) : `${rx.repMin}–${rx.repMax}`) : undefined}
              durationHint={timedRx ? String(rx!.durationSec) : undefined}
              onChange={(patch) => changeSet(set, patch)}
              onComplete={() => props.onComplete(set, (e) => setRowErrors((m) => (e ? { ...m, [set.id]: e } : (({ [set.id]: _d, ...rest }) => (void _d, rest))(m))))}
              onMenu={() => setSetMenuFor(set)}
            />
          );
        })}
      </div>
      <div className="flex items-center gap-1 px-3 pb-3 pt-1">
        <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => void update((s) => ops.addSet(s, se.id, ex?.tracking === 'duration' || ex?.tracking === 'distance_time' ? 'timed' : 'normal'))}>
          {t('workout.addSet')}
        </Button>
        {showLoad && (
          <div className="ml-auto flex items-center gap-1" role="group" aria-label={t('workout.adjustRemainingLoad')}>
            <IconButton size="sm" label={t('workout.decreaseRemainingLoad', { amount: incUnit, unit })} onClick={() => void update((s) => ops.adjustPendingLoad(s, se.id, -inc, (kg) => enteredFor(kg, unit)))}>
              <Minus className="size-4" />
            </IconButton>
            <span className="text-xs text-muted tabular w-12 text-center">
              {numberText(incUnit)} {unit}
            </span>
            <IconButton size="sm" label={t('workout.increaseRemainingLoad', { amount: incUnit, unit })} onClick={() => void update((s) => ops.adjustPendingLoad(s, se.id, inc, (kg) => enteredFor(kg, unit)))}>
              <Plus className="size-4" />
            </IconButton>
          </div>
        )}
      </div>
      {se.notes && <p className="px-4 pb-3 -mt-1 text-xs text-muted whitespace-pre-wrap">{t('workout.noteText', { note: se.notes })}</p>}

      <Sheet open={menu} onClose={() => setMenu(false)} title={ex?.name ?? t('workout.exerciseFallback')}>
        <div className="flex flex-col">
          <MenuItem icon={<Repeat className="size-5" />} label={t('workout.swapExercise')} onClick={() => (setMenu(false), props.onSwap())} />
          {props.onAsk && se.sets.some((x) => !x.completed && x.type !== 'warmup') && (
            <MenuItem icon={<Wrench className="size-5" />} label={t('workout.equipmentBusyAsk')} onClick={() => (setMenu(false), props.onAsk!('swap'))} />
          )}
          {props.onAsk && (
            <MenuItem
              icon={<CircleHelp className="size-5" />}
              label={t('workout.explainThis')}
              onClick={() => (setMenu(false), props.onAsk!('explain', ex && suggestion && suggestion.action !== 'hold' ? shownTarget(suggestion, ex, unit) : undefined))}
            />
          )}
          <MenuItem icon={<ArrowUp className="size-5" />} label={t('workout.moveUp')} disabled={props.index === 0} onClick={() => void update((s) => ops.moveExercise(s, se.id, -1))} />
          <MenuItem icon={<ArrowDown className="size-5" />} label={t('workout.moveDown')} disabled={props.index === props.count - 1} onClick={() => void update((s) => ops.moveExercise(s, se.id, 1))} />
          <MenuItem
            icon={<Link2 className="size-5" />}
            label={props.nextInSuperset ? t('workout.unlinkSuperset') : t('workout.linkSuperset')}
            disabled={props.index === props.count - 1}
            onClick={() => void update((s) => ops.toggleSupersetWithNext(s, se.id))}
          />
          <MenuItem icon={<StickyNote className="size-5" />} label={se.notes ? t('workout.editNote') : t('workout.addNote')} onClick={() => (setMenu(false), setNotes(true))} />
          <div className="px-1">
            <Toggle
              label={t('workout.feltDiscomfort')}
              description={t('workout.discomfortDescription')}
              checked={!!se.discomfort}
              onChange={(v) => void update((s) => ops.setDiscomfort(s, se.id, v))}
            />
          </div>
          {ex && <MenuItem icon={<Info className="size-5" />} label={t('workout.howTo')} href={`/train/exercises/${ex.id}`} />}
          <MenuItem icon={<Trash2 className="size-5" />} label={t('workout.removeExercise')} danger onClick={() => (setMenu(false), setRemoveOpen(true))} />
        </div>
      </Sheet>
      <TextSheet open={notes} title={t('workout.exerciseNote')} multiline value={se.notes ?? ''} onClose={() => setNotes(false)} onSave={(v) => void update((s) => ops.setExerciseNotes(s, se.id, v.trim()))} />
      <SetMenu
        set={setMenuFor ? se.sets.find((x) => x.id === setMenuFor.id) ?? null : null}
        sessionId={props.sessionId}
        canCopy={!!setMenuFor && se.sets.findIndex((x) => x.id === setMenuFor.id) > 0}
        onClose={() => setSetMenuFor(null)}
        onType={(t) => setMenuFor && void update((s) => ops.updateSet(s, se.id, setMenuFor.id, { type: t }))}
        onCopy={() => setMenuFor && void update((s) => ops.copyPreviousSet(s, se.id, setMenuFor.id))}
        onDelete={() => setMenuFor && void update((s) => ops.removeSet(s, se.id, setMenuFor.id))}
        onEffort={(set, patch) => changeSet(set, patch)}
      />
      <ConfirmDialog
        open={removeOpen}
        danger
        title={t('workout.removeExerciseConfirm')}
        body={se.sets.some((x) => x.completed) ? t('workout.removeExerciseBody') : undefined}
        confirmLabel={t('workout.remove')}
        onCancel={() => setRemoveOpen(false)}
        onConfirm={() => {
          setRemoveOpen(false);
          void update((s) => ops.removeExercise(s, se.id));
        }}
      />
    </section>
  );
}

/* ======================================================= Progression card */
type ProgressionChoice = 'applied' | 'kept' | 'custom';

/**
 * Suggestion with three clear choices: Apply (suggested targets into the remaining sets), Keep previous
 * (last session's values) and Customize (edit the sets yourself). "Hide" only hides the tip — it never
 * changes any set, and says so.
 */
function ProgressionCard(props: {
  suggestion: Suggestion;
  se: SessionExercise;
  ex: Exercise;
  unit: WeightUnit;
  targetRir?: number;
  lastWorking: LoggedSet[];
  update: Mut;
  onSwap: () => void;
  onCustomize: () => void;
  /** "Ask coach": open the training assistant with this recommendation and the workout attached. */
  onExplain?: () => void;
}) {
  const { suggestion: sg, se, ex, unit, lastWorking } = props;
  const { t, language } = useT();
  const [hidden, setHidden] = useState(false);
  const [why, setWhy] = useState(false);
  const loaded = usesLoad(ex);
  const pending = se.sets.filter((x) => !x.completed && x.type !== 'warmup');
  const rep = ex.tracking !== 'duration' && ex.tracking !== 'distance_time';

  const applyPatch = (): Partial<LoggedSet> => {
    const p: Partial<LoggedSet> = {};
    if (loaded && sg.loadKg != null) Object.assign(p, { weightKg: sg.loadKg, entered: enteredFor(sg.loadKg, unit) });
    if (rep && sg.targetReps != null) p.reps = sg.targetReps;
    if (!rep && sg.durationSec != null) p.durationSec = sg.durationSec;
    if (sg.distanceM != null) p.distanceM = sg.distanceM;
    return p;
  };
  const keepPatch = (i: number): Partial<LoggedSet> | null => {
    const prev = lastWorking[i] ?? lastWorking[lastWorking.length - 1];
    if (!prev) return null;
    const p: Partial<LoggedSet> = {};
    if (loaded && prev.weightKg != null) Object.assign(p, { weightKg: prev.weightKg, entered: prev.entered ?? enteredFor(prev.weightKg, unit) });
    if (rep && prev.reps != null && prev.reps > 0) p.reps = prev.reps;
    if (!rep && prev.durationSec != null && prev.durationSec > 0) p.durationSec = prev.durationSec;
    if (prev.distanceM != null && prev.distanceM > 0) p.distanceM = prev.distanceM;
    return p;
  };
  const matches = (set: LoggedSet, p: Partial<LoggedSet> | null) =>
    !!p && (Object.keys(p) as (keyof LoggedSet)[]).filter((k) => k !== 'entered').every((k) => (k === 'weightKg' ? Math.abs((set.weightKg ?? -1) - (p.weightKg ?? -1)) < 0.01 : set[k] === p[k]));

  const ap = applyPatch();
  const canApply = Object.keys(ap).length > 0 && pending.length > 0;
  const canKeep = lastWorking.length > 0 && pending.length > 0;
  const choice: ProgressionChoice | null = !pending.length
    ? null
    : canApply && pending.every((x) => matches(x, ap))
      ? 'applied'
      : canKeep && pending.every((x, i) => matches(x, keepPatch(i)))
        ? 'kept'
        : 'custom';

  const writePending = (fn: (set: LoggedSet, i: number) => Partial<LoggedSet> | null) =>
    void props.update((s) => ({
      ...s,
      exercises: s.exercises.map((e) => {
        if (e.id !== se.id) return e;
        let i = 0;
        return { ...e, sets: e.sets.map((st) => (st.completed || st.type === 'warmup' ? st : { ...st, ...(fn(st, i++) ?? {}) })) };
      }),
    }));

  if (hidden) return null;
  const warn = sg.action === 'discomfort_hold' || sg.action === 'review_recovery';
  // Same wording as the workout summary's "Next:" line (one formatter for the engine's target).
  const target = sg.action === 'calibrate' ? null : nextTargetLabel(sg, ex, unit, language);
  // The next action itself (first-time calibration, discomfort/recovery safety) stays visible; rationale is expandable.
  const inlineReason = sg.action === 'calibrate' || warn;
  const askEffort = (sg.effortBasis === 'not_recorded' || sg.effortBasis === 'partial') && (sg.action === 'increase_load' || sg.action === 'reduce_assistance');
  const btn = (active: boolean) => clsx('min-h-11 px-3 rounded-xl text-xs font-medium border', active ? 'bg-accent-soft text-ink border-accent font-semibold' : 'bg-surface border-line-input text-ink hover:bg-surface-2');

  return (
    <div className={clsx('mx-4 mt-2 rounded-xl px-3 py-2 text-xs', warn ? 'bg-warn-soft' : 'bg-surface-2')} aria-label={t('progression.suggestion')} role="group">
      <div className="flex gap-2 items-start">
        <Info className="size-4 shrink-0 mt-px" aria-hidden />
        <div className="flex-1 min-w-0">
          <span className="font-semibold">{actionLabel(sg.action, language)}</span>
          {target && <span className="tabular"> → {target}</span>}
          {askEffort && <p className="mt-0.5">{t('progression.confirmEffort', { rir: props.targetRir ?? 2 })}</p>}
          {(why || inlineReason) && <p className={clsx('mt-0.5', !inlineReason && 'text-muted')}>{suggestionReasonText(sg, language)}</p>}
          <div className="mt-0.5 flex gap-3">
            {!inlineReason && (
              <button className="font-medium underline min-h-8" aria-expanded={why} onClick={() => setWhy((v) => !v)}>
                {why ? t('progression.less') : t('progression.why')}
              </button>
            )}
            {sg.alternativeIds?.length ? (
              <button className="font-medium text-accent underline" onClick={props.onSwap}>
                {t('progression.alternatives')}
              </button>
            ) : null}
            {props.onExplain && (
              <button className="font-medium text-accent underline min-h-8" onClick={props.onExplain}>
                {t('workout.askCoach')}
              </button>
            )}
          </div>
        </div>
        <button className="text-muted underline min-h-11 px-1" onClick={() => setHidden(true)} aria-label={t('progression.hideAria')}>
          {t('progression.hide')}
        </button>
      </div>
      {(canApply || canKeep) && (
        <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={t('progression.chooseTargets')}>
          {canApply && (
            <button className={btn(choice === 'applied')} aria-pressed={choice === 'applied'} onClick={() => writePending(() => applyPatch())}>
              {t('progression.apply')}
            </button>
          )}
          {canKeep && (
            <button className={btn(choice === 'kept')} aria-pressed={choice === 'kept'} onClick={() => writePending((_, i) => keepPatch(i))}>
              {t('progression.keepPrevious')}
            </button>
          )}
          <button className={btn(choice === 'custom')} aria-pressed={choice === 'custom'} onClick={props.onCustomize}>
            {t('progression.customize')}
          </button>
        </div>
      )}
    </div>
  );
}

/** "Last time" entry for one set ("62,5×8" in Icelandic). Numbers follow the current language; units never change. */
function compactSet(st: LoggedSet, ex: Exercise, unit: WeightUnit): string {
  const w = st.weightKg != null ? displayWeight(st.weightKg, unit, st.entered) : null;
  const n = (v: number | null | undefined) => (v == null ? '–' : numberText(v));
  const secs = (v: number) => tNow('workout.compactSeconds', { seconds: v });
  if (ex.tracking === 'duration') return st.durationSec != null ? secs(st.durationSec) : '–s';
  if (ex.tracking === 'distance_time') return [st.distanceM != null ? `${numberText(st.distanceM)} m` : null, st.durationSec != null ? secs(st.durationSec) : null].filter(Boolean).join(' / ') || '–';
  if (ex.tracking === 'assisted') return `${w == null ? '?' : `−${numberText(w)}`}×${n(st.reps)}`;
  if (ex.tracking === 'bodyweight_plus') return `${w == null ? '?' : w > 0 ? `+${numberText(w)}` : tNow('workout.bodyweightMarker')}×${n(st.reps)}`;
  if (ex.tracking === 'reps') return n(st.reps);
  return `${n(w)}×${n(st.reps)}`;
}

export function SetRow(props: {
  set: LoggedSet;
  sessionId: string;
  label: string;
  ex: Exercise | undefined;
  unit: WeightUnit;
  showLoad: boolean;
  showRir: boolean;
  prev?: LoggedSet;
  repHint?: string;
  durationHint?: string;
  isNext?: boolean;
  errors?: FieldErrors;
  onChange: (patch: Partial<LoggedSet>) => CommitResult;
  onComplete: () => void;
  onMenu: () => void;
}) {
  const { set, ex, unit, prev, errors } = props;
  const { t, language } = useT();
  const timed = ex?.tracking === 'duration' || ex?.tracking === 'distance_time';
  const loadPh = prev?.weightKg != null ? formatNumber(displayWeight(prev.weightKg, unit, prev.entered), language) : '';
  const key = (f: string) => draftKey(props.sessionId, set.id, f);
  const cls = clsx('min-h-11 px-1', set.completed && 'bg-transparent border-transparent');
  const errText = errors ? Object.values(errors).filter(Boolean)[0] : undefined;
  return (
    <div data-set-pending={!set.completed && set.type !== 'warmup' ? 'true' : undefined}>
      <div role="row" className={clsx('flex items-center gap-1.5 px-1 py-1 min-h-14 rounded-xl', set.completed && 'bg-success-soft')}>
        <button
          role="cell"
          onClick={props.onMenu}
          aria-label={set.type === 'warmup' ? t('workout.warmupOptionsAria', { label: props.label }) : t('workout.setOptionsAria', { label: props.label })}
          className={clsx('w-11 min-h-11 rounded-lg text-sm font-semibold tabular hover:bg-surface-2', set.type === 'warmup' ? 'text-warn' : set.type === 'drop' ? 'text-info' : 'text-muted')}
        >
          {props.label}
        </button>
        {props.showLoad && (
          <div role="cell" className="flex-1 min-w-0">
            <DraftNumberField
              ariaLabel={t(ex?.tracking === 'assisted' ? 'workout.setAssistanceAria' : 'workout.setLoadAria', { label: props.label, unit })}
              value={set.weightKg == null ? null : displayWeight(set.weightKg, unit, set.entered)}
              placeholder={loadPh}
              max={unit === 'kg' ? 1000 : 2200}
              draftKey={key('weight')}
              setId={set.id}
              error={errors?.weight}
              onCommit={(v) => props.onChange(v == null ? { weightKg: null, entered: undefined } : { weightKg: toKg(v, unit), entered: { value: v, unit } })}
              inputClassName={cls}
            />
          </div>
        )}
        {ex?.tracking === 'distance_time' && (
          <div role="cell" className="flex-1 min-w-0">
            <DraftNumberField
              ariaLabel={t('workout.setDistanceAria', { label: props.label })}
              value={set.distanceM ?? null}
              placeholder={prev?.distanceM != null ? formatNumber(prev.distanceM, language) : ''}
              max={100000}
              draftKey={key('distance')}
              setId={set.id}
              error={errors?.distance}
              onCommit={(v) => props.onChange({ distanceM: v })}
              inputClassName={cls}
            />
          </div>
        )}
        <div role="cell" className="flex-1 min-w-0">
          {timed ? (
            <DraftNumberField
              ariaLabel={t('workout.setDurationAria', { label: props.label })}
              value={set.durationSec ?? null}
              placeholder={prev?.durationSec != null ? String(prev.durationSec) : props.durationHint ?? ''}
              decimals={false}
              max={36000}
              draftKey={key('duration')}
              setId={set.id}
              error={errors?.duration}
              onCommit={(v) => props.onChange({ durationSec: v })}
              inputClassName={cls}
            />
          ) : (
            <DraftNumberField
              ariaLabel={t('workout.setRepsAria', { label: props.label })}
              value={set.reps ?? null}
              placeholder={prev?.reps != null ? String(prev.reps) : props.repHint ?? ''}
              decimals={false}
              max={500}
              draftKey={key('reps')}
              setId={set.id}
              error={errors?.reps}
              onCommit={(v) => props.onChange({ reps: v })}
              inputClassName={cls}
            />
          )}
        </div>
        {props.showRir && ex?.tracking !== 'duration' && (
          <div role="cell" className="w-14">
            <DraftNumberField ariaLabel={t('workout.setRirAria', { label: props.label })} value={set.rir ?? null} decimals={false} max={10} draftKey={key('rir')} setId={set.id} error={errors?.rir} onCommit={(v) => props.onChange({ rir: v })} inputClassName="min-h-11 px-1" />
          </div>
        )}
        <div role="cell" className="w-12 flex justify-center">
          <button
            onClick={props.onComplete}
            aria-pressed={set.completed}
            aria-label={set.completed ? t('workout.setDoneAria', { label: props.label }) : t('workout.completeSetAria', { label: props.label })}
            className={clsx(
              'size-12 rounded-xl flex items-center justify-center border transition-colors duration-[120ms]',
              set.completed ? 'bg-success text-bg border-success' : props.isNext ? 'border-accent bg-surface-2 text-accent' : 'border-line bg-surface-2 text-muted hover:text-ink',
            )}
          >
            {/* Remounts on completion so the ✓ settles in (styles.css → .set-pop). */}
            <Check key={set.completed ? 'done' : 'todo'} className={clsx('size-5', set.completed && 'set-pop')} strokeWidth={3} />
          </button>
        </div>
      </div>
      {errText && (
        <p role="alert" className="px-14 pb-1 text-xs text-danger">
          {errText}
        </p>
      )}
    </div>
  );
}

function SetMenu(props: {
  set: LoggedSet | null;
  sessionId: string;
  canCopy: boolean;
  onClose: () => void;
  onType: (t: SetType) => void;
  onCopy: () => void;
  onDelete: () => void;
  onEffort: (set: LoggedSet, p: Partial<LoggedSet>) => CommitResult;
}) {
  const s = props.set;
  const { t } = useT();
  return (
    <Sheet open={!!s} onClose={props.onClose} title={t('workout.setOptions')}>
      {s && (
        <div className="space-y-4">
          <Segmented<SetType>
            label={t('workout.setType')}
            value={s.type}
            onChange={(type) => props.onType(type)}
            options={[
              { value: 'warmup', label: t('workout.setTypeWarmup') },
              { value: 'normal', label: t('workout.setTypeNormal') },
              { value: 'drop', label: t('workout.setTypeDrop') },
              { value: 'timed', label: t('workout.setTypeTimed') },
            ]}
          />
          <p className="text-xs text-muted">{t('workout.warmupNotCounted')}</p>
          <div className="grid grid-cols-2 gap-3">
            <DraftNumberField label={t('workout.rpeOptional')} hint={t('workout.effortScale')} value={s.rpe ?? null} min={1} max={10} draftKey={draftKey(props.sessionId, s.id, 'rpe')} setId={s.id} onCommit={(v) => props.onEffort(s, { rpe: v })} />
            <DraftNumberField label={t('workout.repsInReserve')} hint={t('workout.rirHint')} value={s.rir ?? null} decimals={false} max={10} draftKey={draftKey(props.sessionId, s.id, 'rir-menu')} setId={s.id} onCommit={(v) => props.onEffort(s, { rir: v })} />
          </div>
          <div className="flex flex-col">
            <MenuItem icon={<Undo2 className="size-5" />} label={t('workout.copyPreviousSet')} disabled={!props.canCopy} onClick={() => (props.onCopy(), props.onClose())} />
            <MenuItem icon={<Trash2 className="size-5" />} label={t('workout.deleteSet')} danger onClick={() => (props.onDelete(), props.onClose())} />
          </div>
        </div>
      )}
    </Sheet>
  );
}

function MenuItem({ icon, label, sub, trailing, onClick, href, disabled, danger }: { icon: React.ReactNode; label: string; sub?: string; trailing?: React.ReactNode; onClick?: () => void; href?: string; disabled?: boolean; danger?: boolean }) {
  const cls = clsx('flex items-center gap-3 min-h-12 px-2 rounded-xl text-left hover:bg-surface-2 disabled:text-disabled-ink disabled:hover:bg-transparent', danger && 'text-danger');
  const body = sub || trailing ? (
    <>
      <span className="flex-1 min-w-0">
        <span className="block">{label}</span>
        {sub && <span className="block text-xs text-muted truncate">{sub}</span>}
      </span>
      {trailing}
    </>
  ) : (
    label
  );
  if (href)
    return (
      <Link to={href} className={cls}>
        {icon}
        {body}
      </Link>
    );
  return (
    <button className={cls} onClick={onClick} disabled={disabled}>
      {icon}
      {body}
    </button>
  );
}

/** A compact chip for the "Ask coach" row. */
function AskChip({ icon, label, onClick, disabled }: { icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="shrink-0 min-h-10 px-3 rounded-full border border-accent/40 bg-accent-soft text-sm font-medium inline-flex items-center gap-1.5 hover:bg-surface-2 disabled:opacity-50"
    >
      {icon}
      {label}
    </button>
  );
}

/** The recommendation as the progression card shows it ("Add weight → 62.5 kg × 8"), for "Explain this". */
function shownTarget(sg: Suggestion | null, ex: Exercise | undefined, unit: WeightUnit, language: Language = getLanguage()): string | undefined {
  if (!sg || !ex || sg.action === 'hold') return undefined;
  const target = sg.action === 'calibrate' ? null : nextTargetLabel(sg, ex, unit, language);
  return `${actionLabel(sg.action, language)}${target ? ` → ${target}` : ''}`;
}
function shownTargetFor(se: SessionExercise, ex: Exercise, history: WorkoutSession[], settings: Settings, experience?: Experience): string | undefined {
  if (!se.prescription) return undefined;
  const sg = suggestionFor({ exerciseId: se.exerciseId, ...se.prescription }, ex, history, settings, experience).suggestion;
  return shownTarget(sg, ex, settings.units.weight);
}

/* =============================================================== Rest bar */
function RestBar({ session, settings, update, now }: { session: WorkoutSession; settings: Settings; update: Mut; now: number }) {
  const { t } = useT();
  const [tick, setTick] = useState(Date.now());
  const r = session.rest;
  const running = !!r?.endsAt;
  useEffect(() => {
    if (!running) return;
    const iv = setInterval(() => setTick(Date.now()), 250);
    return () => clearInterval(iv);
  }, [running]);
  const at = Math.max(now, tick);
  const remaining = ops.restRemainingMs(r, at);
  const firedFor = useRef<number | null>(null);
  useEffect(() => {
    if (!r?.endsAt || remaining == null || remaining > 0) return;
    if (firedFor.current === r.endsAt) return;
    firedFor.current = r.endsAt;
    // Don't alert for timers that expired long ago (e.g. app reopened hours later).
    if (Date.now() - r.endsAt < 10_000) {
      if (settings.rest.sound) beep();
      if (settings.rest.vibrate) vibrate();
    }
  }, [r?.endsAt, remaining, settings.rest.sound, settings.rest.vibrate]);
  if (!r || remaining == null) return null;
  const paused = r.pausedRemainingMs != null;
  const over = remaining === 0 && !paused;
  const pct = r.durationMs > 0 ? Math.min(100, (1 - remaining / r.durationMs) * 100) : 100;
  return (
    <div className="fixed bottom-0 inset-x-0 z-40 pb-safe bg-surface/95 backdrop-blur border-t border-line">
      <div className="h-1 bg-surface-3" aria-hidden>
        <div className="h-full bg-ember transition-[width] duration-200" style={{ width: `${pct}%` }} />
      </div>
      <div className="mx-auto max-w-2xl flex items-center gap-1 px-3 py-2">
        <RestRing pct={over ? 100 : pct} over={over} />
        <div className="flex-1 min-w-0" role="timer" aria-live="off" aria-label={over ? t('workout.restFinished') : t('workout.restRemaining', { duration: formatDuration(remaining / 1000) })}>
          <div className="text-2xl font-bold tabular leading-none">{over ? t('workout.ready') : formatDuration(Math.ceil(remaining / 1000))}</div>
          <div className="text-[11px] text-muted">{paused ? t('workout.restPaused') : over ? t('workout.restFinished') : t('workout.rest')}</div>
        </div>
        {!over && (
          <>
            <Button size="sm" variant="ghost" onClick={() => void update((s) => ops.extendRest(s, Date.now(), -15000))} aria-label={t('workout.subtract15Seconds')}>
              −15
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void update((s) => ops.extendRest(s, Date.now(), 15000))} aria-label={t('workout.add15Seconds')}>
              +15
            </Button>
            <IconButton label={paused ? t('workout.resumeRestTimer') : t('workout.pauseRestTimer')} onClick={() => void update((s) => (paused ? ops.resumeRest(s, Date.now()) : ops.pauseRest(s, Date.now())))}>
              {paused ? <Play className="size-5" /> : <Pause className="size-5" />}
            </IconButton>
          </>
        )}
        <IconButton label={t('workout.restartRestTimer')} onClick={() => void update((s) => ops.resetRest(s, Date.now()))}>
          <RotateCcw className="size-5" />
        </IconButton>
        <IconButton label={over ? t('workout.dismissRestTimer') : t('workout.skipRest')} onClick={() => void update((s) => ops.skipRest(s))}>
          <SkipForward className="size-5" />
        </IconButton>
      </div>
    </div>
  );
}

/** Progress ring around the timer icon; the arc eases between ticks (styles.css → .ring-arc). Decorative. */
function RestRing({ pct, over }: { pct: number; over: boolean }) {
  const r = 16;
  const c = 2 * Math.PI * r;
  return (
    <span className="relative size-10 shrink-0 flex items-center justify-center" aria-hidden>
      <svg viewBox="0 0 40 40" className="absolute inset-0 -rotate-90">
        <circle cx="20" cy="20" r={r} fill="none" strokeWidth="3.5" className="stroke-surface-3" />
        <circle cx="20" cy="20" r={r} fill="none" strokeWidth="3.5" strokeLinecap="round" className={clsx('ring-arc', over ? 'stroke-accent' : 'stroke-accent/80')} strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} />
      </svg>
      <Timer className={clsx('size-4', over ? 'text-accent set-pop' : 'text-muted')} />
    </span>
  );
}

/* ============================================================ Finish flow */
function FinishSheet({ open, session, onClose, onFinish }: { open: boolean; session: WorkoutSession; onClose: () => void; onFinish: (notes: string) => Promise<void> }) {
  const { t, tp } = useT();
  const [notes, setNotes] = useState(session.notes ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setNotes(session.notes ?? '');
  }, [open, session.notes]);
  const done = ops.completedSetCount(session);
  const left = ops.incompleteSetCount(session);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('workout.finishQuestion')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('workout.keepGoing')}
          </Button>
          <Button
            variant="primary"
            disabled={done === 0}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onFinish(notes);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('workout.finish')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {done === 0 ? (
          <p className="text-sm text-muted">{t('workout.noCompletedSets')}</p>
        ) : (
          <p className="text-sm">
            {tp('workout.completedSets', done)}
            {left > 0 && <span className="text-muted"> {tp('workout.unsavedSets', left)}</span>}
          </p>
        )}
        <Textarea label={t('workout.optionalNotes')} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('workout.feelingPlaceholder')} />
      </div>
    </Sheet>
  );
}

function TextSheet({ open, title, value, onClose, onSave, multiline }: { open: boolean; title: string; value: string; onClose: () => void; onSave: (v: string) => void; multiline?: boolean }) {
  const { t } = useT();
  const [v, setV] = useState(value);
  useEffect(() => {
    if (open) setV(value);
  }, [open, value]);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('workout.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onSave(v);
              onClose();
            }}
          >
            {t('workout.save')}
          </Button>
        </>
      }
    >
      {multiline ? <Textarea aria-label={title} value={v} onChange={(e) => setV(e.target.value)} autoFocus /> : <Input aria-label={title} value={v} maxLength={80} onChange={(e) => setV(e.target.value)} autoFocus />}
    </Sheet>
  );
}
