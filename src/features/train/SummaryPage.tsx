import { useEffect, useMemo } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { Award, CheckCircle2, Clock, Dumbbell, Layers, Repeat } from 'lucide-react';
import { useApp } from '@/state/app';
import { alive } from '@/db/repo';
import { Badge, Button, Card, EmptyState, Page, SectionTitle, Spinner, Stat } from '@/components/ui';
import { useExercises } from '@/data/catalog';
import { detectRecords, summarizeSession, VOLUME_CONVENTION_SHORT } from '@/domain/stats';
import { isValidCompletedSet } from '@/domain/setValidation';
import { formatDistance, round, fromKg } from '@/domain/units';
import { formatDate, formatDuration, formatMinutes } from '@/lib/dates';
import { activityLabel, paceOrSpeed } from '@/domain/activities';
import { SharePreview } from '@/features/social/SharePreview';
import { formatLoggedSet } from '@/features/exercises/useExerciseData';
import { celebrateOnce } from '@/components/celebrate';

/** Only a workout finished in the last few minutes gets confetti; reopening an old summary stays calm. */
const JUST_FINISHED_MS = 5 * 60 * 1000;

export default function SummaryPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  return params.get('kind') === 'activity' ? <ActivitySummary id={id} /> : <WorkoutSummary id={id} />;
}

function WorkoutSummary({ id }: { id: string }) {
  const { db, account } = useApp();
  const nav = useNavigate();
  const unit = account.settings.units.weight;
  const { byId } = useExercises();
  const session = useLiveQuery(async () => (await db.sessions.get(id)) ?? null, [db, id]);
  const history = useLiveQuery(async () => alive(await db.sessions.where('status').equals('completed').toArray()), [db]);
  const data = useMemo(() => {
    if (!session || !history) return null;
    const others = history.filter((s) => s.id !== session.id && s.startedAt < session.startedAt);
    return { summary: summarizeSession(session, byId), records: detectRecords(session, others, byId, unit) };
  }, [session, history, byId, unit]);
  const celebrations = account.settings.workout.celebrations !== false;
  const recordCount = data?.records.length ?? -1;
  useEffect(() => {
    if (!celebrations || recordCount < 0 || !session?.endedAt || Date.now() - session.endedAt > JUST_FINISHED_MS) return;
    celebrateOnce(`workout:${session.id}`, { intensity: recordCount > 0 ? 'big' : 'small' });
  }, [celebrations, recordCount, session?.id, session?.endedAt]);

  if (session === undefined || history === undefined) return <Spinner />;
  if (!session || session.deletedAt) return <EmptyState title="Workout not found" action={<Button onClick={() => nav('/')}>Home</Button>} />;
  if (!data) return <Spinner />;
  const { summary, records } = data;
  const vol = summary.volume;
  const recordsForShare = records.map((r) => ({ exercise: byId.get(r.exerciseId)?.name ?? 'Exercise', label: r.label }));

  return (
    <Page title="Workout complete">
      <Card className="p-5" tint="accent">
        <div className="flex items-center gap-2 text-accent">
          <CheckCircle2 className="size-5" aria-hidden />
          <span className="font-semibold">{session.name}</span>
        </div>
        <p className="text-sm text-muted mt-0.5">{formatDate(session.date, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        <p className="font-display text-lg font-bold mt-2">{records.length > 0 ? 'Nicely done, and new records too!' : 'Nicely done. Another one in the books.'}</p>
        <div className="grid grid-cols-3 gap-3 mt-4">
          <Stat label="Duration" value={formatDuration(summary.durationSec)} />
          <Stat label="Working sets" value={summary.workingSets} sub={summary.warmupSets ? `+${summary.warmupSets} warm-up` : undefined} />
          <Stat label="Exercises" value={summary.exercisesDone} />
        </div>
        {(vol.freeWeightKg > 0 || vol.machineKg > 0 || vol.addedBodyweightKg > 0) && (
          <div className="mt-4 text-sm space-y-0.5">
            {vol.freeWeightKg > 0 && <div>Free-weight volume: <span className="tabular font-medium">{fmtVol(vol.freeWeightKg, unit)}</span></div>}
            {vol.machineKg > 0 && <div>Machine/cable volume: <span className="tabular font-medium">{fmtVol(vol.machineKg, unit)}</span></div>}
            {vol.addedBodyweightKg > 0 && <div>Added load (bodyweight moves): <span className="tabular font-medium">{fmtVol(vol.addedBodyweightKg, unit)}</span></div>}
            <p className="text-xs text-faint">{VOLUME_CONVENTION_SHORT} Machine and free-weight volume aren’t comparable, so they’re shown separately.</p>
          </div>
        )}
      </Card>

      {records.length > 0 && (
        <>
          <SectionTitle>New records</SectionTitle>
          <Card className="p-4 space-y-2" tint="celebrate">
            {records.map((r, i) => (
              <div key={i} className="flex items-center gap-3">
                <span className="size-8 rounded-full bg-celebrate-soft text-celebrate flex items-center justify-center shrink-0">
                  <Award className="size-4" aria-hidden />
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{byId.get(r.exerciseId)?.name}</div>
                  <div className="text-xs text-muted">{r.label}</div>
                </div>
              </div>
            ))}
          </Card>
        </>
      )}

      <SectionTitle>What you did</SectionTitle>
      <Card className="divide-y divide-line">
        {session.exercises.map((se) => {
          const ex = byId.get(se.exerciseId);
          return (
            <div key={se.id} className="px-4 py-3">
              <div className="flex items-center gap-2">
                <Dumbbell className="size-4 text-muted" aria-hidden />
                <span className="font-medium text-sm">{ex?.name ?? 'Exercise'}</span>
                {se.discomfort && <Badge tone="warn">Discomfort</Badge>}
              </div>
              <p className="text-xs text-muted mt-1">
                {ex ? se.sets.map((s) => `${s.type === 'warmup' ? 'W ' : ''}${formatLoggedSet(s, ex, unit, account.settings.units.distance)}${isValidCompletedSet(s, ex) ? '' : ' (not counted)'}`).join(' · ') : `${se.sets.length} sets`}
              </p>
            </div>
          );
        })}
      </Card>

      <SectionTitle>Share</SectionTitle>
      <SharePreview session={session} records={recordsForShare} />

      <div className="flex flex-col gap-2 mt-6">
        <Button variant="primary" size="lg" onClick={() => nav('/', { replace: true })}>
          Done
        </Button>
        <div className="grid grid-cols-2 gap-2">
          <Button icon={<Clock className="size-4" />} onClick={() => nav(`/train/history/${session.id}`)}>
            Edit workout
          </Button>
          <Button icon={<Layers className="size-4" />} onClick={() => nav(`/train/history/${session.id}?saveTemplate=1`)}>
            Save as template
          </Button>
        </div>
      </div>
    </Page>
  );
}

function fmtVol(kg: number, unit: 'kg' | 'lb') {
  return `${round(fromKg(kg, unit), 0).toLocaleString('en-GB')} ${unit}`;
}

function ActivitySummary({ id }: { id: string }) {
  const { db, account } = useApp();
  const nav = useNavigate();
  const units = account.settings.units;
  const a = useLiveQuery(async () => (await db.activities.get(id)) ?? null, [db, id]);
  if (a === undefined) return <Spinner />;
  if (!a || a.deletedAt) return <EmptyState title="Activity not found" action={<Button onClick={() => nav('/')}>Home</Button>} />;
  const pace = paceOrSpeed(a, units.distance);
  return (
    <Page title="Activity saved">
      <Card className="p-5">
        <div className="flex items-center gap-2 text-accent">
          <CheckCircle2 className="size-5" aria-hidden />
          <span className="font-semibold">{activityLabel(a)}</span>
        </div>
        <p className="text-sm text-muted mt-0.5">{formatDate(a.date, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        <div className="grid grid-cols-3 gap-3 mt-4">
          <Stat label="Time" value={formatMinutes(a.durationSec)} />
          {a.distanceM != null && <Stat label="Distance" value={formatDistance(a.distanceM, units.distance)} />}
          {pace && <Stat label={pace.kind === 'pace' ? 'Pace' : 'Speed'} value={pace.text} />}
        </div>
        {a.energyKcal != null && (
          <p className="text-xs text-muted mt-3">
            Energy: about {Math.round(a.energyKcal)} kcal ({a.energySource === 'device' ? 'from your device' : a.energySource === 'user' ? 'your estimate' : 'approximate calculation'}). Treat as a rough estimate.
          </p>
        )}
      </Card>
      <SectionTitle>Share</SectionTitle>
      <SharePreview activity={a} />
      <div className="flex flex-col gap-2 mt-6">
        <Button variant="primary" size="lg" onClick={() => nav('/', { replace: true })}>
          Done
        </Button>
        <Button icon={<Repeat className="size-4" />} onClick={() => nav(`/train/activity/${a.id}`)}>
          Edit activity
        </Button>
      </div>
    </Page>
  );
}

