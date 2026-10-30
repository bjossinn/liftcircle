import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import clsx from 'clsx';
import {
  AlertTriangle, ArrowDown, ArrowUp, Check, ChevronDown, Info, Link2, Minus, MoreHorizontal, MoreVertical, Pause, Play, Plus, Repeat, SkipForward,
  StickyNote, Trash2, Timer, Undo2, RotateCcw,
} from 'lucide-react';
import { useApp, useDb } from '@/state/app';
import { saveRecord, deleteRecord, alive } from '@/db/repo';
import { useToast } from '@/components/toast';
import { Badge, Button, ConfirmDialog, EmptyState, IconButton, Input, Segmented, Sheet, Spinner, Textarea, Toggle } from '@/components/ui';
import type { CoachStyle, Exercise, ID, LoggedSet, SessionExercise, SetType, Settings, WeightUnit, WorkoutSession } from '@/domain/types';
import { useExercises } from '@/data/catalog';
import { ExercisePicker } from '@/components/ExercisePicker';
import { loadConventionNote } from '@/data/exerciseMeta';
import { displayWeight, formatWeight, fromKg, round, toKg } from '@/domain/units';
import { formatDuration } from '@/lib/dates';
import * as ops from '@/domain/sessionOps';
import { comparableHistory, incrementFor, workingSets, ACTION_LABELS, type Suggestion } from '@/domain/progression';
import { usesLoad, validateLoggedSet, type SetField } from '@/domain/setValidation';
import { adaptPrescription, fitsConstraints, hasConstraints, substitutionCandidates } from '@/domain/substitution';
import { DraftNumberField, type CommitResult } from './DraftNumberField';
import { DraftRegistry, DraftRegistryContext, clearSessionDrafts, draftKey } from './setDraft';
import { useSubstitutionConstraints } from './hooks';
import { suggestionFor } from '@/domain/program/session';
import { beep, holdWakeLock, primeAudio, vibrate } from './feedback';
import { maybeAutoShare } from '@/social/autoShare';
import { cheerForSet, restOverCheer } from '@/domain/coachCheers';
import type { ToastOptions } from '@/components/toast';
import { cancelRestPush, useRestPush } from '@/pwa/pushScheduler';

/** Persist a change; resolves true when saved, false when the device couldn't store it. */
type Mut = (fn: (s: WorkoutSession) => WorkoutSession) => Promise<boolean>;

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
        await saveRecord('sessions', fn(cur), db);
        setSaveError(null);
        return true;
      };
      chain.current = chain.current.then(run).catch((e: Error) => {
        // Keep the session and the typed drafts; show a persistent, retryable error.
        setSaveError({ message: e?.message || 'Couldn’t save that change on this device.', retry: () => void update(fn) });
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
    const fire = () => {
      const o = latest.current;
      const s = o.session;
      if (!s || s.rest?.endsAt !== endsAt || Date.now() < endsAt) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (restCheerShown(key)) return;
      markRestCheer(key);
      const cheer = restOverCheer(s, o.byId, o.unit, o.style, o.lastLine.current);
      if (!cheer) return;
      o.lastLine.current = cheer.line;
      o.show(cheer.line, { variant: 'coach' });
    };
    const t = setTimeout(fire, Math.max(0, endsAt - Date.now()));
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
  const { db, account, updateAccount } = useApp();
  const settings = account.settings;
  const cheers = cheersEnabled(settings);
  const coachStyle: CoachStyle = settings.coachStyle ?? 'balanced';
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

  if (session === undefined || history === undefined) return <Spinner label="Opening workout" />;
  if (session === null || session.deletedAt)
    return <EmptyState title="Workout not found" body="It may have been discarded." action={<Button onClick={() => nav('/train')}>Go to Train</Button>} />;
  if (session.status === 'completed') {
    return <EmptyState title="This workout is finished" action={<Button onClick={() => nav(`/train/history/${session.id}`, { replace: true })}>View workout</Button>} />;
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
        toast.show(firstError || 'Check this set first', { tone: 'warn' });
        return;
      }
      showErrors(null);
      if (outcome !== 'done') return; // undo: quiet
      const undo = { label: 'Undo', onClick: () => void update((s) => ops.skipRest(ops.toggleSetComplete(s, se.id, set.id, Date.now()).session)) };
      if (!cheers) {
        toast.show('Set logged', { action: undo, duration: 3000 });
        return;
      }
      void db.sessions.get(session.id).then((latest) => {
        const cheer = latest ? cheerForSet({ session: latest, seId: se.id, setId: set.id, style: coachStyle, history: history ?? [], byId, unit: settings.units.weight, last: lastCheer.current }) : null;
        if (!cheer) {
          toast.show('Set logged', { action: undo, duration: 3000 }); // warm-up: no coach popup
          return;
        }
        lastCheer.current = cheer.line;
        toast.show(cheer.line, { variant: 'coach', action: undo });
      });
    });
  };

  const finish = async (notes: string) => {
    registry.flushAll();
    // Go through the same queue so set completions still being saved are included.
    await update((s) => ops.finishSession({ ...s, notes: notes || undefined }, Date.now()));
    const finished = await db.sessions.get(session.id);
    if (!finished || finished.status !== 'completed') {
      toast.show('Couldn’t finish the workout — try again.', { tone: 'error' });
      return;
    }
    setFinishOpen(false);
    clearSessionDrafts(finished.id);
    cancelRestPush(finished.id);
    void maybeAutoShare({ session: finished }, { db, settings, byId }).then((shared) => {
      if (shared) toast.show('Queued to share with your chosen audience', { tone: 'success' });
    });
    nav(`/train/summary/${finished.id}`, { replace: true });
  };

  const fitsUser = constraints && hasConstraints(constraints) ? (e: Exercise) => fitsConstraints(e, constraints) : undefined;

  return (
    <DraftRegistryContext.Provider value={registry}>
    <div className="min-h-dvh pb-[calc(160px+env(safe-area-inset-bottom))]">
      <header className="sticky top-0 z-30 bg-bg/95 backdrop-blur border-b border-line pt-safe">
        <div className="mx-auto max-w-2xl flex items-center gap-1 px-2 min-h-14">
          <IconButton label="Minimise workout" onClick={() => (registry.flushAll(), nav('/train'))}>
            <ChevronDown className="size-6" />
          </IconButton>
          <button className="flex-1 min-w-0 min-h-11 text-left px-1" onClick={() => setRenameOpen(true)} aria-label={`Workout name: ${session.name}. Tap to rename`}>
            <div className="font-semibold truncate">{session.name}</div>
            <div className="text-xs text-muted tabular">
              {paused ? 'Paused' : formatDuration(ops.elapsedMs(session, now) / 1000)} · {done}/{total} sets
            </div>
          </button>
          <IconButton label="Workout options" onClick={() => setOptionsOpen(true)}>
            <MoreVertical className="size-5" />
          </IconButton>
          <IconButton label={paused ? 'Resume workout' : 'Pause workout'} onClick={() => void update((s) => (s.pausedAt ? ops.resumeSession(s, Date.now()) : ops.pauseSession(s, Date.now())))}>
            {paused ? <Play className="size-5" /> : <Pause className="size-5" />}
          </IconButton>
          <Button variant="primary" size="sm" onClick={() => setFinishOpen(true)}>
            Finish
          </Button>
        </div>
      </header>

      <div className="mx-auto max-w-2xl px-3 pt-3 space-y-3">
        {saveError && (
          <div role="alert" className="rounded-xl bg-danger-soft border border-danger/30 px-4 py-3 text-sm flex items-center gap-3">
            <AlertTriangle className="size-4 text-danger shrink-0" aria-hidden />
            <span className="flex-1">Couldn’t save your last change on this device. What you typed is still here — retry, or free up storage space.</span>
            <Button size="sm" onClick={saveError.retry}>
              Retry
            </Button>
          </div>
        )}
        {paused && (
          <div className="rounded-xl bg-warn-soft border border-warn/30 px-4 py-3 text-sm flex items-center gap-3">
            <Pause className="size-4 text-warn" aria-hidden />
            <span className="flex-1">Workout paused — the clock isn’t running.</span>
            <Button size="sm" onClick={() => void update((s) => ops.resumeSession(s, Date.now()))}>
              Resume
            </Button>
          </div>
        )}
        {session.exercises.length === 0 && (
          <EmptyState icon={<Plus className="size-6" />} title="Add your first exercise" body="Search the library or create your own." action={<Button variant="primary" onClick={() => setPicker({ mode: 'add' })}>Add exercise</Button>} />
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
            update={update}
            sessionId={session.id}
            onComplete={(set, showErrors) => onComplete(se, set, showErrors)}
            onSwap={() => {
              const from = get(se.exerciseId);
              setPicker({ mode: 'swap', exId: se.id, suggest: from ? substitutionCandidates(from, list, constraints) : [] });
            }}
          />
        ))}
        {session.exercises.length > 0 && (
          <div className="grid grid-cols-2 gap-2 pt-1">
            <Button icon={<Plus className="size-4" />} onClick={() => setPicker({ mode: 'add' })}>
              Add exercise
            </Button>
            <Button icon={<StickyNote className="size-4" />} onClick={() => setNotesOpen(true)}>
              {session.notes ? 'Edit notes' : 'Workout notes'}
            </Button>
          </div>
        )}
        <div className="flex justify-center pt-4">
          <Button variant="ghost" className="text-danger" icon={<Trash2 className="size-4" />} onClick={() => setDiscardOpen(true)}>
            Discard workout
          </Button>
        </div>
      </div>

      <RestBar session={session} settings={settings} update={update} now={now} />

      <ExercisePicker
        open={!!picker}
        onClose={() => setPicker(null)}
        title={picker?.mode === 'swap' ? 'Swap exercise' : 'Add exercise'}
        suggestIds={picker?.mode === 'swap' ? picker.suggest : undefined}
        fits={picker?.mode === 'swap' ? fitsUser : undefined}
        fitsNote="Showing exercises that fit your equipment, exclusions and limitations."
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
                toast.show('Completed sets stay with the original exercise — added the new one below.', { tone: 'info' });
                const rx = adaptPrescription(cur.prescription, from, ex);
                const left = Math.max(1, cur.sets.filter((x) => !x.completed && x.type !== 'warmup').length);
                return ops.addExercise(s, ex, left, rx ? { ...rx, sets: left } : undefined);
              }
              // Rebuild prescription, set fields, load convention and warm-ups for the new tracking type.
              return ops.swapExercise(s, p.exId, ex, from);
            });
        }}
      />

      <Sheet open={optionsOpen} onClose={() => setOptionsOpen(false)} title="Workout options">
        <div className="px-1">
          <Toggle
            label="Coach cheers during workouts"
            description="A short line from your coach when you finish a set or your rest ends. Works offline."
            checked={cheers}
            onChange={(v) => void updateAccount((a) => ({ ...a, settings: { ...a.settings, workout: { ...a.settings.workout, coachCheers: v } } }))}
          />
        </div>
      </Sheet>

      <FinishSheet open={finishOpen} session={session} onClose={() => setFinishOpen(false)} onFinish={finish} />

      <ConfirmDialog
        open={discardOpen}
        danger
        title="Discard this workout?"
        body={done > 0 ? `${done} completed set${done === 1 ? '' : 's'} will be deleted. This can’t be undone.` : 'Nothing has been logged yet.'}
        confirmLabel="Discard"
        onCancel={() => setDiscardOpen(false)}
        onConfirm={async () => {
          await deleteRecord('sessions', session.id, db);
          clearSessionDrafts(session.id);
          cancelRestPush(session.id);
          setDiscardOpen(false);
          nav('/train', { replace: true });
        }}
      />
      <TextSheet open={renameOpen} title="Workout name" value={session.name} onClose={() => setRenameOpen(false)} onSave={(v) => void update((s) => ({ ...s, name: v.trim() || s.name }))} />
      <TextSheet open={notesOpen} title="Workout notes" multiline value={session.notes ?? ''} onClose={() => setNotesOpen(false)} onSave={(v) => void update((s) => ({ ...s, notes: v.trim() || undefined }))} />
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
  update: Mut;
  sessionId: string;
  onComplete: (set: LoggedSet, showErrors: (e: FieldErrors | null) => void) => void;
  onSwap: () => void;
}) {
  const { se, ex, settings, update, history } = props;
  const unit = settings.units.weight;
  const [menu, setMenu] = useState(false);
  const [notes, setNotes] = useState(false);
  const [setMenuFor, setSetMenuFor] = useState<LoggedSet | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [rowErrors, setRowErrors] = useState<Record<string, FieldErrors>>({});
  const sectionRef = useRef<HTMLElement>(null);
  const last = useMemo(() => comparableHistory(history, se.exerciseId)[0], [history, se.exerciseId]);
  const lastWorking = last ? workingSets(last, ex) : [];
  const suggestion: Suggestion | null = useMemo(() => {
    if (!ex || !se.prescription) return null;
    const rx = { id: se.prescription.slotId ?? se.id, exerciseId: se.exerciseId, warmup: '', priority: 2 as const, alternatives: [], ...se.prescription };
    return suggestionFor(rx, ex, history, settings).suggestion;
  }, [ex, se.prescription, se.id, se.exerciseId, history, settings]);
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
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {se.supersetGroup && (props.nextInSuperset || props.prevInSuperset) && (
              <Badge tone="info">
                <Link2 className="size-3" aria-hidden /> Superset
              </Badge>
            )}
            {se.discomfort && (
              <Badge tone="warn">
                <AlertTriangle className="size-3" aria-hidden /> Discomfort noted
              </Badge>
            )}
          </div>
          <h2 id={`ex-${se.id}`} className="text-[17px] font-semibold leading-tight mt-0.5">
            {ex ? (
              <Link to={`/train/exercises/${ex.id}`} className="hover:underline">
                {ex.name}
              </Link>
            ) : (
              'Unknown exercise'
            )}
          </h2>
          <p className="text-xs text-muted mt-0.5">
            {rx ? `${rx.sets} × ${timedRx ? `${rx.durationSec}s` : rx.repMin === rx.repMax ? rx.repMin : `${rx.repMin}–${rx.repMax}`}${timedRx ? '' : ` · ${rx.targetRir} reps in reserve`} · rest ${formatDuration(rx.restSec)}` : 'Free logging'}
          </p>
          {note && <p className="text-xs text-faint mt-0.5">{note}</p>}
        </div>
        <IconButton label={`Options for ${ex?.name ?? 'exercise'}`} onClick={() => setMenu(true)}>
          <MoreHorizontal className="size-5" />
        </IconButton>
      </div>

      {lastWorking.length > 0 && ex && (
        <p className="px-4 mt-1 text-xs text-muted">
          <span className="text-faint">Last time: </span>
          {lastWorking.map((st) => compactSet(st, ex, unit)).join(', ')}
        </p>
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
        />
      )}

      <div role="table" aria-label={`Sets for ${ex?.name ?? 'exercise'}`} className="px-2 pt-2 pb-1">
        <div role="row" className="flex items-center gap-1.5 px-1 text-[11px] uppercase tracking-wide text-faint">
          <span role="columnheader" className="w-11 text-center">Set</span>
          {showLoad && (
            <span role="columnheader" className="flex-1 text-center">
              {ex?.tracking === 'assisted' ? `Assist ${unit}` : ex?.tracking === 'bodyweight_plus' ? `+${unit}` : unit}
            </span>
          )}
          {ex?.tracking === 'distance_time' && <span role="columnheader" className="flex-1 text-center">Metres</span>}
          {ex?.tracking === 'duration' || ex?.tracking === 'distance_time' ? (
            <span role="columnheader" className="flex-1 text-center">Seconds</span>
          ) : (
            <span role="columnheader" className="flex-1 text-center">Reps{ex?.unilateral ? '/side' : ''}</span>
          )}
          {settings.workout.showRir && ex?.tracking !== 'duration' && <span role="columnheader" className="w-14 text-center">RIR</span>}
          <span role="columnheader" className="w-12 text-center">
            <span className="sr-only">Done</span>
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
              label={set.type === 'warmup' ? 'W' : set.type === 'drop' ? 'D' : set.type === 'timed' ? `T${normalIdx}` : String(normalIdx)}
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
          Add set
        </Button>
        {showLoad && (
          <div className="ml-auto flex items-center gap-1" role="group" aria-label="Adjust load for remaining sets">
            <IconButton size="sm" label={`Decrease remaining sets by ${incUnit} ${unit}`} onClick={() => void update((s) => ops.adjustPendingLoad(s, se.id, -inc, (kg) => enteredFor(kg, unit)))}>
              <Minus className="size-4" />
            </IconButton>
            <span className="text-xs text-muted tabular w-12 text-center">
              {incUnit} {unit}
            </span>
            <IconButton size="sm" label={`Increase remaining sets by ${incUnit} ${unit}`} onClick={() => void update((s) => ops.adjustPendingLoad(s, se.id, inc, (kg) => enteredFor(kg, unit)))}>
              <Plus className="size-4" />
            </IconButton>
          </div>
        )}
      </div>
      {se.notes && <p className="px-4 pb-3 -mt-1 text-xs text-muted whitespace-pre-wrap">Note: {se.notes}</p>}

      <Sheet open={menu} onClose={() => setMenu(false)} title={ex?.name ?? 'Exercise'}>
        <div className="flex flex-col">
          <MenuItem icon={<Repeat className="size-5" />} label="Swap exercise" onClick={() => (setMenu(false), props.onSwap())} />
          <MenuItem icon={<ArrowUp className="size-5" />} label="Move up" disabled={props.index === 0} onClick={() => void update((s) => ops.moveExercise(s, se.id, -1))} />
          <MenuItem icon={<ArrowDown className="size-5" />} label="Move down" disabled={props.index === props.count - 1} onClick={() => void update((s) => ops.moveExercise(s, se.id, 1))} />
          <MenuItem
            icon={<Link2 className="size-5" />}
            label={props.nextInSuperset ? 'Unlink superset with next' : 'Superset with next exercise'}
            disabled={props.index === props.count - 1}
            onClick={() => void update((s) => ops.toggleSupersetWithNext(s, se.id))}
          />
          <MenuItem icon={<StickyNote className="size-5" />} label={se.notes ? 'Edit note' : 'Add note'} onClick={() => (setMenu(false), setNotes(true))} />
          <div className="px-1">
            <Toggle
              label="Felt discomfort"
              description="Pauses automatic load increases for this exercise and suggests alternatives. Not a diagnosis — if pain persists, check with a professional."
              checked={!!se.discomfort}
              onChange={(v) => void update((s) => ops.setDiscomfort(s, se.id, v))}
            />
          </div>
          {ex && <MenuItem icon={<Info className="size-5" />} label="How to do it" href={`/train/exercises/${ex.id}`} />}
          <MenuItem icon={<Trash2 className="size-5" />} label="Remove exercise" danger onClick={() => (setMenu(false), setRemoveOpen(true))} />
        </div>
      </Sheet>
      <TextSheet open={notes} title="Exercise note" multiline value={se.notes ?? ''} onClose={() => setNotes(false)} onSave={(v) => void update((s) => ops.setExerciseNotes(s, se.id, v.trim()))} />
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
        title="Remove exercise?"
        body={se.sets.some((x) => x.completed) ? 'Its completed sets will be removed from this workout.' : undefined}
        confirmLabel="Remove"
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
}) {
  const { suggestion: sg, se, ex, unit, lastWorking } = props;
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
  const target = [
    loaded && sg.loadKg != null ? formatWeight(sg.loadKg, unit) : null,
    rep && sg.targetReps != null ? `${sg.targetReps} reps` : null,
    !rep && sg.durationSec != null ? `${sg.durationSec}s` : null,
    sg.distanceM != null ? `${sg.distanceM} m` : null,
  ].filter(Boolean).join(' × ');
  // The next action itself (first-time calibration, discomfort/recovery safety) stays visible; rationale is expandable.
  const inlineReason = sg.action === 'calibrate' || warn;
  const askEffort = (sg.effortBasis === 'not_recorded' || sg.effortBasis === 'partial') && (sg.action === 'increase_load' || sg.action === 'reduce_assistance');
  const btn = (active: boolean) => clsx('min-h-11 px-3 rounded-xl text-xs font-medium border', active ? 'bg-accent text-accent-ink border-accent' : 'bg-surface border-line text-ink hover:bg-surface-2');

  return (
    <div className={clsx('mx-4 mt-2 rounded-xl px-3 py-2 text-xs', warn ? 'bg-warn-soft' : 'bg-accent-soft')} aria-label="Progression suggestion" role="group">
      <div className="flex gap-2 items-start">
        <Info className="size-4 shrink-0 mt-px" aria-hidden />
        <div className="flex-1 min-w-0">
          <span className="font-semibold">{ACTION_LABELS[sg.action]}</span>
          {target && <span className="tabular"> → {target}</span>}
          {askEffort && <p className="mt-0.5">Effort wasn’t logged. Did those sets feel like about {props.targetRir ?? 2} reps left in the tank? If yes, apply; if not, keep previous.</p>}
          {(why || inlineReason) && <p className={clsx('mt-0.5', !inlineReason && 'text-muted')}>{sg.reason}</p>}
          <div className="mt-0.5 flex gap-3">
            {!inlineReason && (
              <button className="font-medium underline min-h-8" aria-expanded={why} onClick={() => setWhy((v) => !v)}>
                {why ? 'Less' : 'Why?'}
              </button>
            )}
            {sg.alternativeIds?.length ? (
              <button className="font-medium text-accent underline" onClick={props.onSwap}>
                See alternatives
              </button>
            ) : null}
          </div>
        </div>
        <button className="text-muted underline min-h-11 px-1" onClick={() => setHidden(true)} aria-label="Hide this tip (your sets stay as they are)">
          Hide
        </button>
      </div>
      {(canApply || canKeep) && (
        <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Choose targets for the remaining sets">
          {canApply && (
            <button className={btn(choice === 'applied')} aria-pressed={choice === 'applied'} onClick={() => writePending(() => applyPatch())}>
              Apply
            </button>
          )}
          {canKeep && (
            <button className={btn(choice === 'kept')} aria-pressed={choice === 'kept'} onClick={() => writePending((_, i) => keepPatch(i))}>
              Keep previous
            </button>
          )}
          <button className={btn(choice === 'custom')} aria-pressed={choice === 'custom'} onClick={props.onCustomize}>
            Customize
          </button>
        </div>
      )}
    </div>
  );
}

function compactSet(st: LoggedSet, ex: Exercise, unit: WeightUnit): string {
  const w = st.weightKg != null ? displayWeight(st.weightKg, unit, st.entered) : null;
  if (ex.tracking === 'duration') return `${st.durationSec ?? '–'}s`;
  if (ex.tracking === 'distance_time') return [st.distanceM != null ? `${st.distanceM} m` : null, st.durationSec != null ? `${st.durationSec}s` : null].filter(Boolean).join(' / ') || '–';
  if (ex.tracking === 'assisted') return `${w == null ? '?' : `−${w}`}×${st.reps ?? '–'}`;
  if (ex.tracking === 'bodyweight_plus') return `${w == null ? '?' : w > 0 ? `+${w}` : 'BW'}×${st.reps ?? '–'}`;
  if (ex.tracking === 'reps') return `${st.reps ?? '–'}`;
  return `${w ?? '–'}×${st.reps ?? '–'}`;
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
  const timed = ex?.tracking === 'duration' || ex?.tracking === 'distance_time';
  const loadPh = prev?.weightKg != null ? String(displayWeight(prev.weightKg, unit, prev.entered)) : '';
  const key = (f: string) => draftKey(props.sessionId, set.id, f);
  const cls = clsx('min-h-11 px-1', set.completed && 'bg-transparent border-transparent');
  const errText = errors ? Object.values(errors).filter(Boolean)[0] : undefined;
  return (
    <div data-set-pending={!set.completed && set.type !== 'warmup' ? 'true' : undefined}>
      <div role="row" className={clsx('flex items-center gap-1.5 px-1 py-1 rounded-xl', set.completed && 'bg-accent-soft')}>
        <button
          role="cell"
          onClick={props.onMenu}
          aria-label={`Set ${props.label} options${set.type === 'warmup' ? ' (warm-up)' : ''}`}
          className={clsx('w-11 min-h-11 rounded-lg text-sm font-semibold tabular hover:bg-surface-2', set.type === 'warmup' ? 'text-warn' : set.type === 'drop' ? 'text-info' : 'text-muted')}
        >
          {props.label}
        </button>
        {props.showLoad && (
          <div role="cell" className="flex-1 min-w-0">
            <DraftNumberField
              ariaLabel={`Set ${props.label} ${ex?.tracking === 'assisted' ? 'assistance' : 'load'} in ${unit}`}
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
              ariaLabel={`Set ${props.label} distance in metres`}
              value={set.distanceM ?? null}
              placeholder={prev?.distanceM != null ? String(prev.distanceM) : ''}
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
              ariaLabel={`Set ${props.label} duration in seconds`}
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
              ariaLabel={`Set ${props.label} reps`}
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
            <DraftNumberField ariaLabel={`Set ${props.label} reps in reserve`} value={set.rir ?? null} decimals={false} max={10} draftKey={key('rir')} setId={set.id} error={errors?.rir} onCommit={(v) => props.onChange({ rir: v })} inputClassName="min-h-11 px-1" />
          </div>
        )}
        <div role="cell" className="w-12 flex justify-center">
          <button
            onClick={props.onComplete}
            aria-pressed={set.completed}
            aria-label={set.completed ? `Set ${props.label} done. Tap to undo` : `Mark set ${props.label} done`}
            className={clsx(
              'size-11 rounded-xl flex items-center justify-center border transition-colors',
              set.completed ? 'bg-accent text-accent-ink border-accent' : props.isNext ? 'border-accent bg-surface-2 text-accent' : 'border-line bg-surface-2 text-muted hover:text-ink',
            )}
          >
            <Check className="size-5" strokeWidth={3} />
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
  return (
    <Sheet open={!!s} onClose={props.onClose} title="Set options">
      {s && (
        <div className="space-y-4">
          <Segmented<SetType>
            label="Set type"
            value={s.type}
            onChange={(t) => props.onType(t)}
            options={[
              { value: 'warmup', label: 'Warm-up' },
              { value: 'normal', label: 'Normal' },
              { value: 'drop', label: 'Drop' },
              { value: 'timed', label: 'Timed' },
            ]}
          />
          <p className="text-xs text-muted">Warm-ups don’t count toward records or volume.</p>
          <div className="grid grid-cols-2 gap-3">
            <DraftNumberField label="RPE (optional)" hint="Effort 1–10" value={s.rpe ?? null} min={1} max={10} draftKey={draftKey(props.sessionId, s.id, 'rpe')} setId={s.id} onCommit={(v) => props.onEffort(s, { rpe: v })} />
            <DraftNumberField label="Reps in reserve" hint="Reps left in the tank" value={s.rir ?? null} decimals={false} max={10} draftKey={draftKey(props.sessionId, s.id, 'rir-menu')} setId={s.id} onCommit={(v) => props.onEffort(s, { rir: v })} />
          </div>
          <div className="flex flex-col">
            <MenuItem icon={<Undo2 className="size-5" />} label="Copy previous set" disabled={!props.canCopy} onClick={() => (props.onCopy(), props.onClose())} />
            <MenuItem icon={<Trash2 className="size-5" />} label="Delete set" danger onClick={() => (props.onDelete(), props.onClose())} />
          </div>
        </div>
      )}
    </Sheet>
  );
}

function MenuItem({ icon, label, onClick, href, disabled, danger }: { icon: React.ReactNode; label: string; onClick?: () => void; href?: string; disabled?: boolean; danger?: boolean }) {
  const cls = clsx('flex items-center gap-3 min-h-12 px-2 rounded-xl text-left hover:bg-surface-2 disabled:opacity-40', danger && 'text-danger');
  if (href)
    return (
      <Link to={href} className={cls}>
        {icon}
        {label}
      </Link>
    );
  return (
    <button className={cls} onClick={onClick} disabled={disabled}>
      {icon}
      {label}
    </button>
  );
}

/* =============================================================== Rest bar */
function RestBar({ session, settings, update, now }: { session: WorkoutSession; settings: Settings; update: Mut; now: number }) {
  const [tick, setTick] = useState(Date.now());
  const r = session.rest;
  const running = !!r?.endsAt;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick(Date.now()), 250);
    return () => clearInterval(t);
  }, [running]);
  const t = Math.max(now, tick);
  const remaining = ops.restRemainingMs(r, t);
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
        <div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${pct}%` }} />
      </div>
      <div className="mx-auto max-w-2xl flex items-center gap-1 px-3 py-2">
        <Timer className={clsx('size-5 shrink-0', over ? 'text-accent' : 'text-muted')} aria-hidden />
        <div className="flex-1 min-w-0" role="timer" aria-live="off" aria-label={over ? 'Rest finished' : `Rest ${formatDuration(remaining / 1000)} remaining`}>
          <div className="text-2xl font-bold tabular leading-none">{over ? 'Go!' : formatDuration(Math.ceil(remaining / 1000))}</div>
          <div className="text-[11px] text-muted">{paused ? 'Rest paused' : over ? 'Rest finished' : 'Rest'}</div>
        </div>
        {!over && (
          <>
            <Button size="sm" variant="ghost" onClick={() => void update((s) => ops.extendRest(s, Date.now(), -15000))} aria-label="Subtract 15 seconds">
              −15
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void update((s) => ops.extendRest(s, Date.now(), 15000))} aria-label="Add 15 seconds">
              +15
            </Button>
            <IconButton label={paused ? 'Resume rest timer' : 'Pause rest timer'} onClick={() => void update((s) => (paused ? ops.resumeRest(s, Date.now()) : ops.pauseRest(s, Date.now())))}>
              {paused ? <Play className="size-5" /> : <Pause className="size-5" />}
            </IconButton>
          </>
        )}
        <IconButton label="Restart rest timer" onClick={() => void update((s) => ops.resetRest(s, Date.now()))}>
          <RotateCcw className="size-5" />
        </IconButton>
        <IconButton label={over ? 'Dismiss rest timer' : 'Skip rest'} onClick={() => void update((s) => ops.skipRest(s))}>
          <SkipForward className="size-5" />
        </IconButton>
      </div>
    </div>
  );
}

/* ============================================================ Finish flow */
function FinishSheet({ open, session, onClose, onFinish }: { open: boolean; session: WorkoutSession; onClose: () => void; onFinish: (notes: string) => Promise<void> }) {
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
      title="Finish workout?"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep going
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
            Finish
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {done === 0 ? (
          <p className="text-sm text-muted">No sets are marked done yet. Tick at least one set, or discard the workout.</p>
        ) : (
          <p className="text-sm">
            {done} set{done === 1 ? '' : 's'} completed.{left > 0 && <span className="text-muted"> {left} unticked set{left === 1 ? '' : 's'} won’t be saved.</span>}
          </p>
        )}
        <Textarea label="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="How did it feel?" />
      </div>
    </Sheet>
  );
}

function TextSheet({ open, title, value, onClose, onSave, multiline }: { open: boolean; title: string; value: string; onClose: () => void; onSave: (v: string) => void; multiline?: boolean }) {
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
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onSave(v);
              onClose();
            }}
          >
            Save
          </Button>
        </>
      }
    >
      {multiline ? <Textarea aria-label={title} value={v} onChange={(e) => setV(e.target.value)} autoFocus /> : <Input aria-label={title} value={v} maxLength={80} onChange={(e) => setV(e.target.value)} autoFocus />}
    </Sheet>
  );
}
