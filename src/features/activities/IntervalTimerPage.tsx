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
import { t as tNow, useT } from '@/i18n';
import { alive, kvGet, kvSet, newRecord, saveRecord, StorageWriteError } from '@/db/repo';
import type { ActivityTemplate, ActivityType } from '@/domain/types';
import { ACTIVITY_TYPES, activityLabel } from '@/domain/activities';
import { formatDuration } from '@/lib/dates';
import {
  COOLDOWN_LABEL, INTERVAL_LABEL, WARMUP_LABEL, advanceTimer, elapsedSec, expandIntervals, intervalsFromRounds, pauseTimer, remainingMs, resumeTimer, roundsFromIntervals, skipPhase,
  startTimer, totalSeconds, type RoundsPlan, type TimerState,
} from './intervals';

const KV_KEY = 'interval-timer:v1';
interface Persisted {
  plan: RoundsPlan;
  type: ActivityType;
  timer: TimerState | null;
}
/** Default plan; its step names are editable user content, prefilled in the current language. */
const defaultPlan = (): RoundsPlan => ({ warmupSec: 120, steps: [{ label: tNow('activities.timer.work'), seconds: 30 }, { label: tNow('workout.rest'), seconds: 30 }], rounds: 8, cooldownSec: 120 });

/** Display text of a phase label: canonical generated labels (and the old English default step names) are translated. */
function phaseLabelText(label: string): string {
  switch (label) {
    case WARMUP_LABEL:
      return tNow('workout.setTypeWarmup');
    case COOLDOWN_LABEL:
      return tNow('activities.timer.cool_down');
    case INTERVAL_LABEL:
      return tNow('activities.timer.intervalLabel');
    case 'Work':
      return tNow('activities.timer.work');
    case 'Rest':
      return tNow('workout.rest');
    default:
      return label;
  }
}

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
  const { t } = useT();
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">{label}</legend>
      <div className="grid grid-cols-2 gap-1.5">
        <NumberInput ariaLabel={t('activities.timer.x_minutes', { label })} value={m} onChange={(v) => onChange(Math.max(min, (v ?? 0) * 60 + s))} decimals={false} min={0} max={180} suffix="m" />
        <NumberInput ariaLabel={t('activities.timer.x_seconds', { label })} value={s} onChange={(v) => onChange(Math.max(min, m * 60 + (v ?? 0)))} decimals={false} min={0} max={59} suffix="s" />
      </div>
    </fieldset>
  );
}

export default function IntervalTimerPage() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const toast = useToast();
  const { t, tp } = useT();
  const { db, account } = useApp();
  const rest = account.settings.rest;
  const templates = alive(useLiveQuery(() => db.activityTemplates.toArray(), [db]) ?? []).filter((t) => t.intervals?.length);

  const [loaded, setLoaded] = useState(false);
  const [plan, setPlan] = useState<RoundsPlan>(defaultPlan);
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
      const ts = Date.now();
      setNow(ts);
      const cur = timerRef.current;
      if (!cur) return;
      const r = advanceTimer(cur, ts);
      if (r.changed) {
        const done = r.state.status === 'done';
        if (sound) beep(done ? 660 : 990, done ? 600 : 350);
        if (buzz) vibrate(done ? [300, 120, 300] : 250);
        const p = r.state.phases[r.state.index];
        setAnnounce(
          done
            ? tNow('activities.timer.intervalsFinished')
            : p.round
              ? tNow('activities.timer.phaseRound', { label: phaseLabelText(p.label), round: p.round, rounds: p.rounds ?? 1 })
              : phaseLabelText(p.label),
        );
        lastCountdown.current = null;
        timerRef.current = r.state;
        setTimer(r.state);
      } else if (sound) {
        const secLeft = Math.ceil(remainingMs(cur, ts) / 1000);
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
      toast.show(t('activities.timer.add_at_least_one_interval_longer'), { tone: 'warn' });
      return;
    }
    unlock();
    const ts = Date.now();
    setNow(ts);
    setTimer(startTimer(phases, ts));
    const p = phases[0];
    setAnnounce(t('activities.timer.phaseStarted', { label: phaseLabelText(p.label) }));
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

  // Prefills the new activity's notes (editable) and the save sheet, in the current language.
  const describe = (p: RoundsPlan) =>
    [
      t('activities.timer.describe', { rounds: p.rounds, steps: p.steps.map((s) => `${phaseLabelText(s.label)} ${formatDuration(s.seconds)}`).join(', ') }),
      p.warmupSec ? t('activities.timer.describeWarmup', { duration: formatDuration(p.warmupSec) }) : null,
      p.cooldownSec ? t('activities.timer.describeCooldown', { duration: formatDuration(p.cooldownSec) }) : null,
    ].filter(Boolean).join(', ');

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
      toast.show(t('activities.timer.interval_template_saved'), { tone: 'success' });
    } catch (e) {
      toast.show(e instanceof StorageWriteError ? e.message : t('activities.form.couldnt_save_the_template'), { tone: 'error' });
    }
  };

  const back = (
    <IconButton label={t('common.back')} onClick={() => nav(-1)}>
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
      <Page title={t('today.intervalTimer')} back={back}>
        <div aria-live="assertive" className="sr-only">{announce}</div>
        <Card className="p-6 flex flex-col items-center text-center gap-2">
          {done ? (
            <>
              <p className="text-sm text-muted">{t('activities.timer.finished')}</p>
              <p className="text-5xl font-bold tabular">{formatDuration(elapsedSec(timer, now))}</p>
              <p className="text-sm text-muted">{t('activities.timer.total_active_time')}</p>
            </>
          ) : (
            <>
              <p className="text-lg font-semibold text-accent">{phase ? phaseLabelText(phase.label) : null}</p>
              {phase?.round && (
                <p className="text-sm text-muted">
                  {t('activities.timer.roundOf', { round: phase.round, rounds: phase.rounds ?? 1 })}
                </p>
              )}
              <p className="text-7xl font-bold tabular leading-none my-2" aria-label={tp('activities.timer.secondsRemaining', Math.ceil(rem / 1000))}>
                {formatDuration(Math.ceil(rem / 1000))}
              </p>
              <p className="text-sm text-muted">{next ? t('activities.timer.next_x_x', { label: phaseLabelText(next.label), duration: formatDuration(next.seconds) }) : t('activities.timer.last_interval')}</p>
              {timer.status === 'paused' && <p className="text-sm font-medium text-warn">{t('workout.paused')}</p>}
            </>
          )}
          <div className="w-full mt-3">
            <ProgressBar value={Math.round(doneSec)} max={allSec} label={t('activities.timer.overall_progress')} />
            <p className="text-xs text-muted mt-1 tabular">
              {t('activities.timer.progressOf', { done: formatDuration(Math.round(doneSec)), total: formatDuration(allSec) })}
            </p>
          </div>
        </Card>

        {done ? (
          <div className="flex flex-col gap-2 mt-4">
            <Button variant="primary" size="lg" block onClick={logActivity}>
              {t('activities.timer.log_as', { type: activityLabel({ type }).toLowerCase() })}
            </Button>
            <Select aria-label={t('activities.timer.activity_type_to_log')} value={type} onChange={(e) => setType(e.target.value as ActivityType)}>
              {ACTIVITY_TYPES.map((at) => (
                <option key={at.type} value={at.type}>{at.label}</option>
              ))}
            </Select>
            <Button block onClick={() => setTimer(null)}>{t('activities.timer.done_without_logging')}</Button>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2 mt-4">
            <Button size="lg" onClick={() => setConfirmReset(true)} icon={<RotateCcw className="size-5" />}>
              {t('activities.timer.reset')}
            </Button>
            {timer.status === 'running' ? (
              <Button size="lg" variant="primary" onClick={pause} icon={<Pause className="size-5" />}>
                {t('ai.pause')}
              </Button>
            ) : (
              <Button size="lg" variant="primary" onClick={resume} icon={<Play className="size-5" />}>
                {t('workout.resume')}
              </Button>
            )}
            <Button size="lg" onClick={skip} icon={<SkipForward className="size-5" />}>
              {t('activities.timer.skip')}
            </Button>
          </div>
        )}

        <Card className="px-4 py-2 mt-4">
          <Toggle checked={sound} onChange={setSound} label={t('activities.timer.sound')} disabled={!audioOk} description={audioOk ? undefined : t('activities.timer.not_supported_in_this_browser')} />
          <Toggle checked={buzz} onChange={setBuzz} label={t('activities.timer.vibration')} disabled={!canVibrate()} description={canVibrate() ? undefined : t('activities.timer.not_supported_on_this_device')} />
          <Toggle checked={keepAwake} onChange={setKeepAwake} label={t('activities.timer.keep_screen_on')} disabled={!wakeOk} description={wakeOk ? undefined : t('activities.timer.not_supported_in_this_browser')} />
        </Card>
        <Notice className="mt-3">{t('activities.timer.alerts_while_the_screen_is_locked')}</Notice>

        <ConfirmDialog open={confirmReset} title={t('activities.timer.reset_the_timer')} body={t('activities.timer.your_progress_through_these_intervals_will')} confirmLabel={t('activities.timer.reset')} danger onConfirm={reset} onCancel={() => setConfirmReset(false)} />
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
    <Page title={t('today.intervalTimer')} back={back}>
      {templates.length > 0 && (
        <Select
          label={t('activities.timer.saved_interval_templates')}
          value=""
          onChange={(e) => {
            const tpl = templates.find((x) => x.id === e.target.value);
            if (tpl) {
              applyTemplate(tpl);
              toast.show(t('activities.timer.loaded_x', { name: tpl.name }), { tone: 'success' });
            }
          }}
        >
          <option value="">{t('activities.timer.choose_a_template')}</option>
          {templates.map((tpl) => (
            <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
          ))}
        </Select>
      )}

      <SectionTitle>{t('workout.setTypeWarmup')}</SectionTitle>
      <Card className="p-4">
        <MinSec label={t('workout.setTypeWarmup')} seconds={plan.warmupSec} onChange={(v) => setPlan((p) => ({ ...p, warmupSec: v }))} />
        <p className="text-xs text-muted mt-1.5">Set to 0 to skip.</p>
      </Card>

      <SectionTitle>{t('activities.timer.each_round')}</SectionTitle>
      <Card as="section" className="divide-y divide-line">
        {plan.steps.map((s, i) => (
          <div key={i} className="p-3 flex flex-col gap-2">
            <div className="flex items-center gap-1">
              <Input aria-label={t('activities.timer.step_x_name', { number: i + 1 })} value={s.label} onChange={(e) => setStep(i, { label: e.target.value })} maxLength={30} className="flex-1" />
              <IconButton label={t('activities.timer.move_step_x_up', { number: i + 1 })} size="sm" disabled={i === 0} onClick={() => move(i, -1)}>
                <ChevronUp className="size-4" />
              </IconButton>
              <IconButton label={t('activities.timer.move_step_x_down', { number: i + 1 })} size="sm" disabled={i === plan.steps.length - 1} onClick={() => move(i, 1)}>
                <ChevronDown className="size-4" />
              </IconButton>
              <IconButton label={t('activities.timer.remove_step_x', { number: i + 1 })} size="sm" disabled={plan.steps.length <= 1} onClick={() => setPlan((p) => ({ ...p, steps: p.steps.filter((_, j) => j !== i) }))}>
                <Trash2 className="size-4 text-danger" />
              </IconButton>
            </div>
            <MinSec label={t('activities.timer.step_x_x', { number: i + 1, label: s.label || t('activities.timer.intervalFallback') })} seconds={s.seconds} onChange={(v) => setStep(i, { seconds: v })} />
          </div>
        ))}
        <div className="p-3">
          <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setPlan((p) => ({ ...p, steps: [...p.steps, { label: p.steps.length % 2 ? t('workout.rest') : t('activities.timer.work'), seconds: 30 }] }))} disabled={plan.steps.length >= 10}>
            {t('activities.timer.add_step')}
          </Button>
        </div>
      </Card>
      <div className="mt-3">
        <NumberInput label={t('activities.timer.rounds')} value={plan.rounds} onChange={(v) => setPlan((p) => ({ ...p, rounds: Math.max(1, Math.min(99, v ?? 1)) }))} decimals={false} min={1} max={99} />
      </div>

      <SectionTitle>{t('activities.timer.cool_down')}</SectionTitle>
      <Card className="p-4">
        <MinSec label={t('activities.timer.cool_down')} seconds={plan.cooldownSec} onChange={(v) => setPlan((p) => ({ ...p, cooldownSec: v }))} />
        <p className="text-xs text-muted mt-1.5">Set to 0 to skip.</p>
      </Card>

      <div className="mt-4">
        <Select label={t('activities.timer.activity_type_for_logging_afterwards')} value={type} onChange={(e) => setType(e.target.value as ActivityType)}>
          {ACTIVITY_TYPES.map((at) => (
            <option key={at.type} value={at.type}>{at.label}</option>
          ))}
        </Select>
      </div>

      <Card className="px-4 py-2 mt-4">
        <Toggle checked={sound} onChange={setSound} label={t('activities.timer.sound')} disabled={!audioOk} description={audioOk ? t('activities.timer.beeps_at_each_change_and_a') : t('activities.timer.not_supported_in_this_browser')} />
        <Toggle checked={buzz} onChange={setBuzz} label={t('activities.timer.vibration')} disabled={!canVibrate()} description={canVibrate() ? undefined : t('activities.timer.not_supported_on_this_device')} />
        <Toggle checked={keepAwake} onChange={setKeepAwake} label={t('activities.timer.keep_screen_on')} disabled={!('wakeLock' in navigator)} description={'wakeLock' in navigator ? undefined : t('activities.timer.not_supported_in_this_browser')} />
      </Card>

      <div className="flex flex-col gap-2 mt-5">
        <Button variant="primary" size="lg" block icon={<Play className="size-5" />} onClick={start} disabled={!phases.length}>
          {t('activities.timer.start', { duration: formatDuration(total) })}
        </Button>
        <Button
          variant="ghost"
          block
          icon={<BookmarkPlus className="size-4" />}
          onClick={() => {
            setTplName(t('activities.timer.defaultTemplateName', { activity: activityLabel({ type }), rounds: plan.rounds }));
            setSaveOpen(true);
          }}
        >
          {t('summary.saveTemplate')}
        </Button>
      </div>
      <p className="text-xs text-muted mt-3">{t('activities.timer.alerts_while_the_screen_is_locked_2')}</p>

      <Sheet
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title={t('activities.timer.save_interval_template')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setSaveOpen(false)}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={saveTemplate} disabled={!tplName.trim()}>{t('common.save')}</Button>
          </>
        }
      >
        <p className="text-sm text-muted mb-3">{describe(plan)}</p>
        <Input label={t('activities.form.template_name')} value={tplName} onChange={(e) => setTplName(e.target.value)} maxLength={60} autoFocus />
      </Sheet>
    </Page>
  );
}
