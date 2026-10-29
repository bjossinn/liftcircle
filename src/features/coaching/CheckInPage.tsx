/**
 * /coaching/checkin/:relationshipId — the client sends a short check-in to their coach.
 * The coach sees it only while "Check-ins" sharing is on (enforced by the server).
 */
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Send } from 'lucide-react';
import { Button, Card, EmptyState, ErrorState, Notice, NumberInput, Page, SectionTitle, Segmented, Spinner, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import { coachingApi } from '@/backend/coaching';
import type { CheckIn } from '@/backend/coachingContract';
import { toKg } from '@/domain/units';
import { uuid } from '@/lib/id';
import { coachingError } from '@/coaching/errors';
import { relationshipWritable } from '@/coaching/relationship';
import { BackButton, CoachingAccessNotice, useCoachingAccess, useLoad } from './tools/common';

type Rating = 1 | 2 | 3 | 4 | 5;
const SCALES: { key: 'energy' | 'sleep' | 'soreness' | 'stress'; label: string; low: string; high: string }[] = [
  { key: 'energy', label: 'Energy', low: 'Very low', high: 'Great' },
  { key: 'sleep', label: 'Sleep quality', low: 'Poor', high: 'Great' },
  { key: 'soreness', label: 'Soreness', low: 'None', high: 'Very sore' },
  { key: 'stress', label: 'Stress', low: 'Calm', high: 'Very stressed' },
];

export default function CheckInPage() {
  const { relationshipId = '' } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { account } = useApp();
  const unit = account.settings.units.weight;
  const { access } = useCoachingAccess();
  const ok = access === 'ok';
  const rel = useLoad(async () => (await coachingApi.myRelationships()).find((r) => r.id === relationshipId && !r.viewerIsCoach) ?? null, [relationshipId], ok);

  const [id, setId] = useState(() => uuid()); // stable across retries → no duplicate check-ins
  const [ratings, setRatings] = useState<Partial<Record<(typeof SCALES)[number]['key'], Rating>>>({});
  const [bw, setBw] = useState<number | null>(null);
  const [wins, setWins] = useState('');
  const [struggles, setStruggles] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const empty = Object.keys(ratings).length === 0 && bw == null && !wins.trim() && !struggles.trim() && !note.trim();
  const bwError = bw != null && (bw <= 0 || toKg(bw, unit) < 20 || toKg(bw, unit) > 400) ? 'Enter a realistic bodyweight.' : null;

  const submit = async () => {
    if (empty || bwError) return;
    setBusy(true);
    setError(null);
    try {
      const answers: CheckIn['answers'] = {
        ...ratings,
        bodyweightKg: bw != null ? Math.round(toKg(bw, unit) * 100) / 100 : null,
        wins: wins.trim() || undefined,
        struggles: struggles.trim() || undefined,
      };
      await coachingApi.submitCheckIn({ id, relationshipId, answers, note: note.trim() || undefined });
      toast.show('Check-in sent', { tone: 'success' });
      setId(uuid());
      nav('/coaching/my');
    } catch (e) {
      setError(coachingError(e, 'Your check-in wasn’t sent. Your answers are still here — try again.'));
    } finally {
      setBusy(false);
    }
  };

  const r = rel.data;
  const w = relationshipWritable(r ?? null);
  return (
    <Page title="Check-in" back={<BackButton />}>
      {!ok && access !== 'offline' ? (
        <CoachingAccessNotice access={access} what="Check-ins" />
      ) : rel.error && r === undefined ? (
        <ErrorState title="Couldn’t load your coaching" message={rel.error} onRetry={rel.reload} />
      ) : ok && r === undefined ? (
        <Spinner label="Loading" />
      ) : r === null ? (
        <EmptyState title="No active coaching found" body="Check-ins go to your current coach." action={<Button onClick={() => nav('/coaching/my')}>My coach</Button>} />
      ) : (
        <form
          className="flex flex-col gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {access === 'offline' && (
            <Notice tone="warn" className="mb-2">
              You’re offline. Fill in your check-in now and send it when you’re back online — your answers stay on this screen.
            </Notice>
          )}
          {r && !w.ok && (
            <Notice tone="warn" className="mb-2">
              Check-ins can’t be sent right now. {w.reason}
            </Notice>
          )}
          {r && (
            <Notice tone={r.scopes.checkins ? 'info' : 'warn'} className="mb-2">
              {r.scopes.checkins ? (
                <>
                  “Check-ins” sharing is <strong>on</strong>: {r.coach.displayName} can see this check-in.{' '}
                </>
              ) : (
                <>
                  “Check-ins” sharing is <strong>off</strong>: {r.coach.displayName} can’t see check-ins until you turn it on.{' '}
                </>
              )}
              <Link to="/coaching/my#sharing" className="underline font-medium">
                Change sharing
              </Link>
            </Notice>
          )}

          <SectionTitle>How are you feeling?</SectionTitle>
          <Card className="px-4 py-3 flex flex-col gap-4">
            {SCALES.map((s) => (
              <div key={s.key}>
                <div className="flex items-baseline justify-between mb-1.5">
                  <span className="text-sm font-medium" id={`lbl-${s.key}`}>
                    {s.label}
                  </span>
                  <span className="text-xs text-faint">
                    1 = {s.low} · 5 = {s.high}
                  </span>
                </div>
                <Segmented<Rating | 0>
                  label={`${s.label}, 1 ${s.low} to 5 ${s.high}`}
                  value={ratings[s.key] ?? 0}
                  onChange={(v) => setRatings((cur) => (v === 0 || cur[s.key] === v ? omit(cur, s.key) : { ...cur, [s.key]: v as Rating }))}
                  options={([1, 2, 3, 4, 5] as Rating[]).map((n) => ({ value: n, label: String(n) }))}
                />
              </div>
            ))}
            <NumberInput label={`Bodyweight (optional, ${unit})`} value={bw} onChange={setBw} suffix={unit} min={0} error={bwError} hint="Only if you want your coach to see it." />
          </Card>

          <SectionTitle>Since your last check-in</SectionTitle>
          <div className="flex flex-col gap-3">
            <Textarea label="Wins" placeholder="New best, more consistent, felt strong…" maxLength={1000} value={wins} onChange={(e) => setWins(e.target.value)} />
            <Textarea label="Struggles" placeholder="Missed sessions, low energy, an exercise that didn’t feel right…" maxLength={1000} value={struggles} onChange={(e) => setStruggles(e.target.value)} />
            <Textarea label="Anything else for your coach" maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <p className="text-xs text-muted mt-2">Describe how things feel — not a diagnosis. For pain that persists, see a qualified professional.</p>
          {error && (
            <p role="alert" className="text-sm text-danger mt-2">
              {error}
            </p>
          )}
          <div className="flex justify-end mt-3">
            <Button type="submit" variant="primary" icon={<Send className="size-4" />} loading={busy} disabled={empty || !!bwError || !ok || (r != null && !w.ok)}>
              Send check-in
            </Button>
          </div>
        </form>
      )}
    </Page>
  );
}

function omit<T extends object, K extends keyof T>(o: T, k: K): T {
  const { [k]: _drop, ...rest } = o;
  void _drop;
  return rest as T;
}
