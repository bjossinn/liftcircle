import { useEffect, useMemo } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowRight, Award, CheckCircle2, CircleHelp, Clock, Dumbbell, Layers, Repeat } from 'lucide-react';
import { useApp } from '@/state/app';
import { alive } from '@/db/repo';
import { Badge, Button, Card, EmptyState, Page, SectionTitle, Spinner, Stat } from '@/components/ui';
import { useExercises } from '@/data/catalog';
import { detectRecords, summarizeSession, volumeConventionShort } from '@/domain/stats';
import { nextTargetsFor } from '@/domain/nextTargets';
import { isValidCompletedSet } from '@/domain/setValidation';
import { formatDistance, round, fromKg } from '@/domain/units';
import { formatDate, formatDuration, formatMinutes } from '@/lib/dates';
import { activityLabel, paceOrSpeed } from '@/domain/activities';
import { SharePreview } from '@/features/social/SharePreview';
import { formatLoggedSet } from '@/features/exercises/useExerciseData';
import { celebrateOnce } from '@/components/celebrate';
import { openCoachWith } from '@/features/coaching/ai/workoutContext';
import { numberText, useT } from '@/i18n';
import { exerciseDisplayName } from '@/data/catalogText';
import { workoutDisplayName } from '@/features/program/parts';

/** Only a workout finished in the last few minutes gets the brief celebration; reopening an old summary stays calm. */
const JUST_FINISHED_MS = 5 * 60 * 1000;

export default function SummaryPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  return params.get('kind') === 'activity' ? <ActivitySummary id={id} /> : <WorkoutSummary id={id} />;
}

function WorkoutSummary({ id }: { id: string }) {
  const { db, account, auth, backendConfigured } = useApp();
  // "Explain" next to a next target opens the training assistant with this workout attached (signed-in accounts only).
  const aiEntry = backendConfigured && auth.status === 'signed_in';
  const nav = useNavigate();
  const { t, language } = useT();
  const unit = account.settings.units.weight;
  const { byId } = useExercises();
  const session = useLiveQuery(async () => (await db.sessions.get(id)) ?? null, [db, id]);
  const history = useLiveQuery(async () => alive(await db.sessions.where('status').equals('completed').toArray()), [db]);
  const data = useMemo(() => {
    if (!session || !history) return null;
    const others = history.filter((s) => s.id !== session.id && s.startedAt < session.startedAt);
    return {
      summary: summarizeSession(session, byId),
      records: detectRecords(session, others, byId, unit, language),
      // The progression engine's next target per exercise (the only place next loads come from).
      next: nextTargetsFor(session, history, byId, account.settings, account.profile.experience, language),
    };
  }, [session, history, byId, unit, account.settings, account.profile.experience, language]);
  const celebrations = account.settings.workout.celebrations !== false;
  const recordCount = data?.records.length ?? -1;
  useEffect(() => {
    if (!celebrations || recordCount < 0 || !session?.endedAt || Date.now() - session.endedAt > JUST_FINISHED_MS) return;
    celebrateOnce(`workout:${session.id}`, { intensity: recordCount > 0 ? 'big' : 'small' });
  }, [celebrations, recordCount, session?.id, session?.endedAt]);

  if (session === undefined || history === undefined) return <Spinner />;
  if (!session || session.deletedAt) return <EmptyState title={t('workout.notFound')} action={<Button onClick={() => nav('/')}>{t('summary.home')}</Button>} />;
  if (!data) return <Spinner />;
  const { summary, records, next } = data;
  const vol = summary.volume;
  const recordsForShare = records.map((r) => ({ exercise: (byId.get(r.exerciseId) ? exerciseDisplayName(byId.get(r.exerciseId)) : t('workout.exerciseFallback')), label: r.label }));

  return (
    <Page title={t('summary.complete')}>
      <Card className="p-5" tint="accent">
        <div className="flex items-center gap-2 text-accent">
          <CheckCircle2 className="size-5" aria-hidden />
          <span className="font-semibold">{workoutDisplayName(session)}</span>
        </div>
        <p className="text-sm text-muted mt-0.5">{formatDate(session.date, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        <p className="font-display text-lg font-bold mt-2">{records.length > 0 ? t('summary.savedWithRecords') : t('summary.saved')}</p>
        <div className="grid grid-cols-3 gap-3 mt-4">
          <Stat label={t('summary.duration')} value={formatDuration(summary.durationSec)} />
          <Stat label={t('summary.workingSets')} value={summary.workingSets} sub={summary.warmupSets ? t('summary.warmupCount', { count: summary.warmupSets }) : undefined} />
          <Stat label={t('summary.exercises')} value={summary.exercisesDone} />
        </div>
        {(vol.freeWeightKg > 0 || vol.machineKg > 0 || vol.addedBodyweightKg > 0) && (
          <div className="mt-4 text-sm space-y-0.5">
            {vol.freeWeightKg > 0 && <div>{withValue(t('summary.freeWeightVolume', { volume: SLOT }), fmtVol(vol.freeWeightKg, unit))}</div>}
            {vol.machineKg > 0 && <div>{withValue(t('summary.machineVolume', { volume: SLOT }), fmtVol(vol.machineKg, unit))}</div>}
            {vol.addedBodyweightKg > 0 && <div>{withValue(t('summary.addedBodyweightVolume', { volume: SLOT }), fmtVol(vol.addedBodyweightKg, unit))}</div>}
            <p className="text-xs text-faint">{volumeConventionShort(language)} {t('summary.volumeNotComparable')}</p>
          </div>
        )}
      </Card>

      {records.length > 0 && (
        <>
          <SectionTitle>{t('summary.newRecords')}</SectionTitle>
          <Card className="p-4 space-y-2" tint="celebrate">
            {records.map((r, i) => (
              <div key={i} className="flex items-center gap-3">
                <span className="size-8 rounded-full bg-celebrate-soft text-celebrate flex items-center justify-center shrink-0">
                  <Award className="size-4" aria-hidden />
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{byId.get(r.exerciseId) ? exerciseDisplayName(byId.get(r.exerciseId)) : null}</div>
                  <div className="text-xs text-muted">{r.label}</div>
                </div>
              </div>
            ))}
          </Card>
        </>
      )}

      <SectionTitle>{t('summary.whatYouDid')}</SectionTitle>
      <Card className="divide-y divide-line">
        {session.exercises.map((se) => {
          const ex = byId.get(se.exerciseId);
          const target = next.get(se.exerciseId);
          return (
            <div key={se.id} className="px-4 py-3">
              <div className="flex items-center gap-2">
                <Dumbbell className="size-4 text-muted" aria-hidden />
                <span className="font-medium text-sm">{(ex ? exerciseDisplayName(ex) : t('workout.exerciseFallback'))}</span>
                {se.discomfort && <Badge tone="warn">{t('summary.discomfort')}</Badge>}
              </div>
              <p className="text-xs text-muted mt-1">
                {se.sets.length === 0
                  ? t('summary.noCompletedSets')
                  : ex
                    ? se.sets.map((s) => `${s.type === 'warmup' ? `${t('workout.warmupMarker')} ` : ''}${formatLoggedSet(s, ex, unit, account.settings.units.distance, language)}${isValidCompletedSet(s, ex) ? '' : ` ${t('summary.notCounted')}`}`).join(' · ')
                    : t('summary.setCount', { count: se.sets.length })}
              </p>
              {target && (
                <div className="text-xs mt-1" data-testid="next-target">
                  <p className="flex items-center gap-1 flex-wrap">
                    <ArrowRight className="size-4 text-accent shrink-0" aria-hidden />
                    <span className="font-medium tabular">{target.text}</span>
                    <span className="text-muted">· {target.label}</span>
                    {aiEntry && (
                      <button
                        type="button"
                        className="ml-auto inline-flex items-center gap-1 min-h-8 px-2 rounded-lg text-accent font-medium hover:bg-surface-2"
                        aria-label={t('summary.explainTarget', { exercise: ex ? exerciseDisplayName(ex) : t('summary.thisExercise') })}
                        onClick={() =>
                          void openCoachWith(db, nav, { intent: 'explain', sessionId: session.id, focusId: se.id, shownTarget: `${target.text} (${target.label})`, userId: auth.userId })
                        }
                      >
                        <CircleHelp className="size-4" aria-hidden /> {t('summary.explain')}
                      </button>
                    )}
                  </p>
                  {target.caveat && <p className="text-muted mt-0.5 pl-[18px]">{target.caveat}</p>}
                </div>
              )}
            </div>
          );
        })}
      </Card>

      <SectionTitle>{t('summary.share')}</SectionTitle>
      <SharePreview session={session} records={recordsForShare} />

      <div className="flex flex-col gap-2 mt-6">
        <Button variant="primary" size="lg" onClick={() => nav('/', { replace: true })}>
          {t('summary.done')}
        </Button>
        <div className="grid grid-cols-2 gap-2">
          <Button icon={<Clock className="size-4" />} onClick={() => nav(`/train/history/${session.id}`)}>
            {t('summary.editWorkout')}
          </Button>
          <Button icon={<Layers className="size-4" />} onClick={() => nav(`/train/history/${session.id}?saveTemplate=1`)}>
            {t('summary.saveTemplate')}
          </Button>
        </div>
      </div>
    </Page>
  );
}

const SLOT = '\u0000';
/** A sentence with its value emphasized (the sentence is translated whole; the value goes where its slot is). */
function withValue(sentence: string, value: string) {
  const [before, after = ''] = sentence.split(SLOT);
  return (
    <>
      {before}
      <span className="tabular font-medium">{value}</span>
      {after}
    </>
  );
}

/** Whole-unit volume with digit grouping ("12,345 kg" / "12.345 kg"); the unit never changes with the language. */
function fmtVol(kg: number, unit: 'kg' | 'lb') {
  return `${numberText(round(fromKg(kg, unit), 0), 0, true)} ${unit}`;
}

function ActivitySummary({ id }: { id: string }) {
  const { db, account } = useApp();
  const nav = useNavigate();
  const { t } = useT();
  const units = account.settings.units;
  const a = useLiveQuery(async () => (await db.activities.get(id)) ?? null, [db, id]);
  if (a === undefined) return <Spinner />;
  if (!a || a.deletedAt) return <EmptyState title={t('summary.activityNotFound')} action={<Button onClick={() => nav('/')}>{t('summary.home')}</Button>} />;
  const pace = paceOrSpeed(a, units.distance);
  return (
    <Page title={t('summary.activitySaved')}>
      <Card className="p-5">
        <div className="flex items-center gap-2 text-accent">
          <CheckCircle2 className="size-5" aria-hidden />
          <span className="font-semibold">{activityLabel(a)}</span>
        </div>
        <p className="text-sm text-muted mt-0.5">{formatDate(a.date, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        <div className="grid grid-cols-3 gap-3 mt-4">
          <Stat label={t('summary.time')} value={formatMinutes(a.durationSec)} />
          {a.distanceM != null && <Stat label={t('summary.distance')} value={formatDistance(a.distanceM, units.distance)} />}
          {pace && <Stat label={pace.kind === 'pace' ? t('summary.pace') : t('summary.speed')} value={pace.text} />}
        </div>
        {a.energyKcal != null && (
          <p className="text-xs text-muted mt-3">
            {t(a.energySource === 'device' ? 'summary.energyFromDevice' : a.energySource === 'user' ? 'summary.energyFromUser' : 'summary.energyCalculated', { kcal: Math.round(a.energyKcal) })}
          </p>
        )}
      </Card>
      <SectionTitle>{t('summary.share')}</SectionTitle>
      <SharePreview activity={a} />
      <div className="flex flex-col gap-2 mt-6">
        <Button variant="primary" size="lg" onClick={() => nav('/', { replace: true })}>
          {t('summary.done')}
        </Button>
        <Button icon={<Repeat className="size-4" />} onClick={() => nav(`/train/activity/${a.id}`)}>
          {t('summary.editActivity')}
        </Button>
      </div>
    </Page>
  );
}

