/* Interval timer (/train/intervals): build or load intervals, deadline-based timing, optional logging. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { BookmarkPlus, ChevronDown, ChevronLeft, ChevronUp, Pause, Play, Plus, RotateCcw, SkipForward, Trash2 } from 'lucide-react';
import {
  Button, Card, ConfirmDialog, IconButton, Input, Notice, NumberInput, Page, ProgressBar, SectionTitle, Select, Sheet, Toggle,
} from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import { alive, kvGet, kvSet, newRecord, saveRecord, StorageWriteError } from '@/db/repo';
import type { ActivityTemplate, ActivityType } from '@/domain/types';
import { ACTIVITY_TYPES, activityLabel } from '@/domain/activities';
import { formatDuration } from '@/lib/dates';
import {
  advanceTimer, elapsedSec, expandIntervals, intervalsFromRounds, pauseTimer, remainingMs, resumeTimer, roundsFromIntervals, skipPhase,
  startTimer, totalSeconds, type RoundsPlan, type TimerState,
} from './intervals';

const KV_KEY = 'interval-timer:v1';
interface Persisted {
  plan: RoundsPlan;
  type: ActivityType;
  timer: TimerState | null;
}
const DEFAULT_PLAN: RoundsPlan = { warmupSec: 120, steps: [{ label: 'Work', seconds: 30 }, { label: 'Rest', seconds: 30 }], rounds: 8, cooldownSec: 120 };

/* ----------------------------------------------------- device capabilities */
function useBeeper() {
  const ctx = useRef<AudioContext | null>(null);
  const unlock = useCallback(() => {
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      if (!ctx.current) ctx.current = new AC();
      if (ctx.current.state === 'suspended') void ctx.current.resume();
    } catch {
      ctx.current = null;
    }
  }, []);
  const beep = useCallback((freq = 880, ms = 160) => {
    const c = ctx.current;
    if (!c) return;
    try {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.0001, c.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.25, c.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + ms / 1000);
      osc.connect(gain).connect(c.destination);
      osc.start();
      osc.stop(c.currentTime + ms / 1000 + 0.02);
    } catch {
      /* audio unavailable */
    }
  }, []);
  useEffect(() => () => void ctx.current?.close().catch(() => undefined), []);
  return { unlock, beep, supported: typeof window !== 'undefined' && !!(window.AudioContext ?? (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext) };
}

const canVibrate = () => typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
const vibrate = (pattern: number | number[]) => {
  try {
    if (canVibrate()) navigator.vibrate(pattern);
  } catch {
    /* ignore */
  }
};

function useWakeLock(active: boolean) {
  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  useEffect(() => {
    if (!active || !supported) return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        if (document.visibilityState !== 'visible') return;
        const s = await navigator.wakeLock.request('screen');
        if (cancelled) void s.release();
        else sentinel = s;
      } catch {
        /* denied or unsupported */
      }
    };
    void acquire();
    const onVis = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVis);
      void sentinel?.release().catch(() => undefined);
    };
  }, [active, supported]);
  return supported;
}

/* ----------------------------------------------------------- m:s input */
function MinSec({ label, seconds, onChange, min = 0 }: { label: string; seconds: number; onChange: (s: number) => void; min?: number }) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">{label}</legend>
      <div className="grid grid-cols-2 gap-1.5">
        <NumberInput ariaLabel={`${label} minutes`} value={m} onChange={(v) => onChange(Math.max(min, (v ?? 0) * 60 + s))} decimals={false} min={0} max={180} suffix="m" />
        <NumberInput ariaLabel={`${label} seconds`} value={s} onChange={(v) => onChange(Math.max(min, m * 60 + (v ?? 0)))} decimals={false} min={0} max={59} suffix="s" />
      </div>
    </fieldset>
  );
}

export default function IntervalTimerPage() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const toast = useToast();
  const { db, account } = useApp();
  const rest = account.settings.rest;
  const templates = alive(useLiveQuery(() => db.activityTemplates.toArray(), [db]) ?? []).filter((t) => t.intervals?.length);

  const [loaded, setLoaded] = useState(false);
  const [plan, setPlan] = useState<RoundsPlan>(DEFAULT_PLAN);
  const [type, setType] = useState<ActivityType>('run');
  const [timer, setTimer] = useState<TimerState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [sound, setSound] = useState(rest.sound);
  const [buzz, setBuzz] = useState(rest.vibrate);
  const [keepAwake, setKeepAwake] = useState(rest.keepAwake);
  const [saveOpen, setSaveOpen] = useState(false);
  const [tplName, setTplName] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);
  const [announce, setAnnounce] = useState('');
  const lastCountdown = useRef<number | null>(null);
  const timerRef = useRef<TimerState | null>(null);
  useEffect(() => {
    timerRef.current = timer;
  }, [timer]);
  const { unlock, beep, supported: audioOk } = useBeeper();

  const applyTemplate = useCallback((t: ActivityTemplate) => {
    if (!t.intervals?.length) return;
    setPlan(roundsFromIntervals(t.intervals));
    setType(t.type);
  }, []);

  // Restore persisted state (so a reload or app switch resumes the timer from its deadline).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = await kvGet<Persisted>(KV_KEY, db).catch(() => undefined);
      if (cancelled) return;
      const tplId = params.get('template');
      const tpl = tplId ? await db.activityTemplates.get(tplId) : undefined;
      if (cancelled) return;
      if (tpl?.intervals?.length && !(saved?.timer && (saved.timer.status === 'running' || saved.timer.status === 'paused'))) {
        applyTemplate(tpl);
      } else if (saved) {
        setPlan(saved.plan);
        setType(saved.type);
        if (saved.timer && saved.timer.status !== 'idle') setTimer(saved.timer);
      }
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [db, params, applyTemplate]);

  useEffect(() => {
    if (!loaded) return;
    void kvSet(KV_KEY, { plan, type, timer } satisfies Persisted, db).catch(() => undefined);
  }, [loaded, plan, type, timer, db]);

  const phases = useMemo(() => expandIntervals(intervalsFromRounds(plan)), [plan]);
  const total = totalSeconds(phases);

  // Deadline-based ticking. Also re-evaluates immediately when the page becomes visible again.
  const running = timer?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const tick = () => {
      const t = Date.now();
      setNow(t);
      const cur = timerRef.current;
      if (!cur) return;
      const r = advanceTimer(cur, t);
      if (r.changed) {
        const done = r.state.status === 'done';
        if (sound) beep(done ? 660 : 990, done ? 600 : 350);
        if (buzz) vibrate(done ? [300, 120, 300] : 250);
        const p = r.state.phases[r.state.index];
        setAnnounce(done ? 'Intervals finished' : `${p.label}${p.round ? `, round ${p.round} of ${p.rounds}` : ''}`);
        lastCountdown.current = null;
        timerRef.current = r.state;
        setTimer(r.state);
      } else if (sound) {
        const secLeft = Math.ceil(remainingMs(cur, t) / 1000);
        if (secLeft <= 3 && secLeft >= 1 && lastCountdown.current !== secLeft) {
          lastCountdown.current = secLeft;
          beep(660, 90);
        }
      }
    };
    tick();
    const iv = window.setInterval(tick, 250);
    const onVis = () => document.visibilityState === 'visible' && tick();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.clearInterval(iv);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [running, sound, buzz, beep]);

  const wakeOk = useWakeLock(!!running && keepAwake);

  const start = () => {
    if (!phases.length) {
      toast.show('Add at least one interval longer than 0 seconds', { tone: 'warn' });
      return;
    }
    unlock();
    const t = Date.now();
    setNow(t);
    setTimer(startTimer(phases, t));
    const p = phases[0];
    setAnnounce(`${p.label} started`);
    if (sound) beep(990, 250);
    if (buzz) vibrate(150);
  };
  const pause = () => setTimer((t) => (t ? pauseTimer(t, Date.now()) : t));
  const resume = () => {
    unlock();
    const n = Date.now();
    setNow(n);
    setTimer((t) => (t ? resumeTimer(t, n) : t));
  };
  const skip = () => {
    const n = Date.now();
    setNow(n);
    setTimer((t) => (t ? skipPhase(t, n) : t));
  };
  const reset = () => {
    setTimer(null);
    setConfirmReset(false);
  };

  const describe = (p: RoundsPlan) =>
    `Intervals: ${p.rounds} × (${p.steps.map((s) => `${s.label} ${formatDuration(s.seconds)}`).join(', ')})${p.warmupSec ? `, warm-up ${formatDuration(p.warmupSec)}` : ''}${p.cooldownSec ? `, cool-down ${formatDuration(p.cooldownSec)}` : ''}`;

  const logActivity = () => {
    if (!timer) return;
    const dur = elapsedSec(timer, Date.now());
    const q = new URLSearchParams({ type, duration: String(Math.max(60, dur)), notes: describe(plan) });
    setTimer(null);
    nav(`/train/activity/new?${q.toString()}`);
  };

  const saveTemplate = async () => {
    const name = tplName.trim();
    if (!name) return;
    try {
      await saveRecord(
        'activity_templates',
        newRecord<Omit<ActivityTemplate, 'id' | 'createdAt' | 'updatedAt'>>({ name, type, durationSec: total, intervals: intervalsFromRounds(plan) }),
        db,
      );
      setSaveOpen(false);
      toast.show('Interval template saved', { tone: 'success' });
    } catch (e) {
      toast.show(e instanceof StorageWriteError ? e.message : 'Couldn’t save the template', { tone: 'error' });
    }
  };

  const back = (
    <IconButton label="Back" onClick={() => nav(-1)}>
      <ChevronLeft className="size-6" />
    </IconButton>
  );

  /* ------------------------------------------------------------ running */
  if (timer && timer.status !== 'idle') {
    const phase = timer.phases[timer.index];
    const next = timer.phases[timer.index + 1];
    const rem = remainingMs(timer, now);
    const done = timer.status === 'done';
    const doneSec = timer.phases.slice(0, timer.index).reduce((s, p) => s + p.seconds, 0) + (done ? phase?.seconds ?? 0 : (phase?.seconds ?? 0) - rem / 1000);
    const allSec = totalSeconds(timer.phases);
    return (
      <Page title="Interval timer" back={back}>
        <div aria-live="assertive" className="sr-only">{announce}</div>
        <Card className="p-6 flex flex-col items-center text-center gap-2">
          {done ? (
            <>
              <p className="text-sm text-muted">Finished</p>
              <p className="text-5xl font-bold tabular">{formatDuration(elapsedSec(timer, now))}</p>
              <p className="text-sm text-muted">Total active time</p>
            </>
          ) : (
            <>
              <p className="text-lg font-semibold text-accent">{phase?.label}</p>
              {phase?.round && (
                <p className="text-sm text-muted">
                  Round {phase.round} of {phase.rounds}
                </p>
              )}
              <p className="text-7xl font-bold tabular leading-none my-2" aria-label={`${Math.ceil(rem / 1000)} seconds remaining`}>
                {formatDuration(Math.ceil(rem / 1000))}
              </p>
              <p className="text-sm text-muted">{next ? `Next: ${next.label} · ${formatDuration(next.seconds)}` : 'Last interval'}</p>
              {timer.status === 'paused' && <p className="text-sm font-medium text-warn">Paused</p>}
            </>
          )}
          <div className="w-full mt-3">
            <ProgressBar value={Math.round(doneSec)} max={allSec} label="Overall progress" />
            <p className="text-xs text-muted mt-1 tabular">
              {formatDuration(Math.round(doneSec))} of {formatDuration(allSec)}
            </p>
          </div>
        </Card>

        {done ? (
          <div className="flex flex-col gap-2 mt-4">
            <Button variant="primary" size="lg" block onClick={logActivity}>
              Log as {activityLabel({ type }).toLowerCase()} activity
            </Button>
            <Select aria-label="Activity type to log" value={type} onChange={(e) => setType(e.target.value as ActivityType)}>
              {ACTIVITY_TYPES.map((t) => (
                <option key={t.type} value={t.type}>{t.label}</option>
              ))}
            </Select>
            <Button block onClick={() => setTimer(null)}>Done without logging</Button>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2 mt-4">
            <Button size="lg" onClick={() => setConfirmReset(true)} icon={<RotateCcw className="size-5" />}>
              Reset
            </Button>
            {timer.status === 'running' ? (
              <Button size="lg" variant="primary" onClick={pause} icon={<Pause className="size-5" />}>
                Pause
              </Button>
            ) : (
              <Button size="lg" variant="primary" onClick={resume} icon={<Play className="size-5" />}>
                Resume
              </Button>
            )}
            <Button size="lg" onClick={skip} icon={<SkipForward className="size-5" />}>
              Skip
            </Button>
          </div>
        )}

        <Card className="px-4 py-2 mt-4">
          <Toggle checked={sound} onChange={setSound} label="Sound" disabled={!audioOk} description={audioOk ? undefined : 'Not supported in this browser'} />
          <Toggle checked={buzz} onChange={setBuzz} label="Vibration" disabled={!canVibrate()} description={canVibrate() ? undefined : 'Not supported on this device'} />
          <Toggle checked={keepAwake} onChange={setKeepAwake} label="Keep screen on" disabled={!wakeOk} description={wakeOk ? undefined : 'Not supported in this browser'} />
        </Card>
        <Notice className="mt-3">Alerts while the screen is locked or the app is in the background depend on your browser and may be late or silent. The timer catches up as soon as you return.</Notice>

        <ConfirmDialog open={confirmReset} title="Reset the timer?" body="Your progress through these intervals will be cleared." confirmLabel="Reset" danger onConfirm={reset} onCancel={() => setConfirmReset(false)} />
      </Page>
    );
  }

  /* ------------------------------------------------------------- builder */
  const setStep = (i: number, patch: Partial<RoundsPlan['steps'][number]>) => setPlan((p) => ({ ...p, steps: p.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const move = (i: number, d: -1 | 1) =>
    setPlan((p) => {
      const steps = [...p.steps];
      const j = i + d;
      if (j < 0 || j >= steps.length) return p;
      [steps[i], steps[j]] = [steps[j], steps[i]];
      return { ...p, steps };
    });

  return (
    <Page title="Interval timer" back={back}>
      {templates.length > 0 && (
        <Select
          label="Saved interval templates"
          value=""
          onChange={(e) => {
            const t = templates.find((x) => x.id === e.target.value);
            if (t) {
              applyTemplate(t);
              toast.show(`Loaded “${t.name}”`, { tone: 'success' });
            }
          }}
        >
          <option value="">Choose a template…</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </Select>
      )}

      <SectionTitle>Warm-up</SectionTitle>
      <Card className="p-4">
        <MinSec label="Warm-up" seconds={plan.warmupSec} onChange={(v) => setPlan((p) => ({ ...p, warmupSec: v }))} />
        <p className="text-xs text-muted mt-1.5">Set to 0 to skip.</p>
      </Card>

      <SectionTitle>Each round</SectionTitle>
      <Card as="section" className="divide-y divide-line">
        {plan.steps.map((s, i) => (
          <div key={i} className="p-3 flex flex-col gap-2">
            <div className="flex items-center gap-1">
              <Input aria-label={`Step ${i + 1} name`} value={s.label} onChange={(e) => setStep(i, { label: e.target.value })} maxLength={30} className="flex-1" />
              <IconButton label={`Move step ${i + 1} up`} size="sm" disabled={i === 0} onClick={() => move(i, -1)}>
                <ChevronUp className="size-4" />
              </IconButton>
              <IconButton label={`Move step ${i + 1} down`} size="sm" disabled={i === plan.steps.length - 1} onClick={() => move(i, 1)}>
                <ChevronDown className="size-4" />
              </IconButton>
              <IconButton label={`Remove step ${i + 1}`} size="sm" disabled={plan.steps.length <= 1} onClick={() => setPlan((p) => ({ ...p, steps: p.steps.filter((_, j) => j !== i) }))}>
                <Trash2 className="size-4 text-danger" />
              </IconButton>
            </div>
            <MinSec label={`Step ${i + 1} (${s.label || 'interval'})`} seconds={s.seconds} onChange={(v) => setStep(i, { seconds: v })} />
          </div>
        ))}
        <div className="p-3">
          <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setPlan((p) => ({ ...p, steps: [...p.steps, { label: p.steps.length % 2 ? 'Rest' : 'Work', seconds: 30 }] }))} disabled={plan.steps.length >= 10}>
            Add step
          </Button>
        </div>
      </Card>
      <div className="mt-3">
        <NumberInput label="Rounds" value={plan.rounds} onChange={(v) => setPlan((p) => ({ ...p, rounds: Math.max(1, Math.min(99, v ?? 1)) }))} decimals={false} min={1} max={99} />
      </div>

      <SectionTitle>Cool-down</SectionTitle>
      <Card className="p-4">
        <MinSec label="Cool-down" seconds={plan.cooldownSec} onChange={(v) => setPlan((p) => ({ ...p, cooldownSec: v }))} />
        <p className="text-xs text-muted mt-1.5">Set to 0 to skip.</p>
      </Card>

      <div className="mt-4">
        <Select label="Activity type (for logging afterwards)" value={type} onChange={(e) => setType(e.target.value as ActivityType)}>
          {ACTIVITY_TYPES.map((t) => (
            <option key={t.type} value={t.type}>{t.label}</option>
          ))}
        </Select>
      </div>

      <Card className="px-4 py-2 mt-4">
        <Toggle checked={sound} onChange={setSound} label="Sound" disabled={!audioOk} description={audioOk ? 'Beeps at each change and a 3-second countdown' : 'Not supported in this browser'} />
        <Toggle checked={buzz} onChange={setBuzz} label="Vibration" disabled={!canVibrate()} description={canVibrate() ? undefined : 'Not supported on this device'} />
        <Toggle checked={keepAwake} onChange={setKeepAwake} label="Keep screen on" disabled={!('wakeLock' in navigator)} description={'wakeLock' in navigator ? undefined : 'Not supported in this browser'} />
      </Card>

      <div className="flex flex-col gap-2 mt-5">
        <Button variant="primary" size="lg" block icon={<Play className="size-5" />} onClick={start} disabled={!phases.length}>
          Start · {formatDuration(total)}
        </Button>
        <Button
          variant="ghost"
          block
          icon={<BookmarkPlus className="size-4" />}
          onClick={() => {
            setTplName(`${activityLabel({ type })} intervals ${plan.rounds}×`);
            setSaveOpen(true);
          }}
        >
          Save as template
        </Button>
      </div>
      <p className="text-xs text-muted mt-3">Alerts while the screen is locked or the app is in the background depend on your browser.</p>

      <Sheet
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title="Save interval template"
        footer={
          <>
            <Button variant="ghost" onClick={() => setSaveOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={saveTemplate} disabled={!tplName.trim()}>Save</Button>
          </>
        }
      >
        <p className="text-sm text-muted mb-3">{describe(plan)}</p>
        <Input label="Template name" value={tplName} onChange={(e) => setTplName(e.target.value)} maxLength={60} autoFocus />
      </Sheet>
    </Page>
  );
}
