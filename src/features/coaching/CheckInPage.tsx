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
import { BackButton, CoachingAccessNotice, slot, useCoachingAccess, useLoad, withSlots } from './tools/common';
import { useT, type MessageKey } from '@/i18n';

type Rating = 1 | 2 | 3 | 4 | 5;
const SCALES: { key: 'energy' | 'sleep' | 'soreness' | 'stress'; label: MessageKey; low: MessageKey; high: MessageKey }[] = [
  { key: 'energy', label: 'activities.form.energy', low: 'coaching.checkIn.energy_low', high: 'coaching.checkIn.energy_high' },
  { key: 'sleep', label: 'coaching.checkIn.sleep_quality', low: 'coaching.checkIn.sleep_low', high: 'coaching.checkIn.sleep_high' },
  { key: 'soreness', label: 'coaching.checkIn.soreness', low: 'coaching.checkIn.soreness_low', high: 'coaching.checkIn.soreness_high' },
  { key: 'stress', label: 'coaching.checkIn.stress', low: 'coaching.checkIn.stress_low', high: 'coaching.checkIn.stress_high' },
];

export default function CheckInPage() {
  const { relationshipId = '' } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { t } = useT();
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
  const bwError = bw != null && (bw <= 0 || toKg(bw, unit) < 20 || toKg(bw, unit) > 400) ? t('coaching.checkIn.realistic_bodyweight') : null;

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
      toast.show(t('coaching.checkIn.check_in_sent'), { tone: 'success' });
      setId(uuid());
      nav('/coaching/my');
    } catch (e) {
      setError(coachingError(e, t('coaching.checkIn.not_sent')));
    } finally {
      setBusy(false);
    }
  };

  const r = rel.data;
  const w = relationshipWritable(r ?? null);
  return (
    <Page title={t('coaching.checkIn.check_in')} back={<BackButton />}>
      {!ok && access !== 'offline' ? (
        <CoachingAccessNotice access={access} what={t('coaching.checkIn.what_check_ins')} />
      ) : rel.error && r === undefined ? (
        <ErrorState title={t('coaching.hub.couldnt_load_your_coaching')} message={rel.error} onRetry={rel.reload} />
      ) : ok && r === undefined ? (
        <Spinner label={t('common.loading')} />
      ) : r === null ? (
        <EmptyState title={t('coaching.checkIn.no_active_coaching_found')} body={t('coaching.checkIn.check_ins_go_to_your_current')} action={<Button onClick={() => nav('/coaching/my')}>{t('coaching.hub.my_coach')}</Button>} />
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
              {t('coaching.checkIn.youre_offline_fill_in_your_check')}
            </Notice>
          )}
          {r && !w.ok && (
            <Notice tone="warn" className="mb-2">
              {t('coaching.checkIn.check_ins_cant_be_sent_right')} {w.reason}
            </Notice>
          )}
          {r && (
            <Notice tone={r.scopes.checkins ? 'info' : 'warn'} className="mb-2">
              {r.scopes.checkins ? (
                <>
                  {withSlots(t('coaching.checkIn.check_ins_sharing_is', { state: slot('state'), name: r.coach.displayName }), { state: <strong>{t('coaching.checkIn.on')}</strong> })}{' '}
                </>
              ) : (
                <>
                  {withSlots(t('coaching.checkIn.check_ins_sharing_is_off', { state: slot('state'), name: r.coach.displayName }), { state: <strong>{t('coaching.checkIn.off')}</strong> })}{' '}
                </>
              )}
              <Link to="/coaching/my#sharing" className="underline font-medium">
                {t('coaching.checkIn.change_sharing')}
              </Link>
            </Notice>
          )}

          <SectionTitle>{t('coaching.checkIn.how_are_you_feeling')}</SectionTitle>
          <Card className="px-4 py-3 flex flex-col gap-4">
            {SCALES.map((s) => (
              <div key={s.key}>
                <div className="flex items-baseline justify-between mb-1.5">
                  <span className="text-sm font-medium" id={`lbl-${s.key}`}>
                    {t(s.label)}
                  </span>
                  <span className="text-xs text-faint">
                    1 = {t(s.low)} · 5 = {t(s.high)}
                  </span>
                </div>
                <Segmented<Rating | 0>
                  label={t('coaching.checkIn.x_1_x_to_5_x', { label: t(s.label), low: t(s.low), high: t(s.high) })}
                  value={ratings[s.key] ?? 0}
                  onChange={(v) => setRatings((cur) => (v === 0 || cur[s.key] === v ? omit(cur, s.key) : { ...cur, [s.key]: v as Rating }))}
                  options={([1, 2, 3, 4, 5] as Rating[]).map((n) => ({ value: n, label: String(n) }))}
                />
              </div>
            ))}
            <NumberInput label={t('coaching.checkIn.bodyweight_optional_x', { unit })} value={bw} onChange={setBw} suffix={unit} min={0} error={bwError} hint={t('coaching.checkIn.only_if_you_want_your_coach')} />
          </Card>

          <SectionTitle>{t('coaching.checkIn.since_your_last_check_in')}</SectionTitle>
          <div className="flex flex-col gap-3">
            <Textarea label={t('coaching.checkIn.wins')} placeholder={t('coaching.checkIn.new_best_more_consistent_felt_strong')} maxLength={1000} value={wins} onChange={(e) => setWins(e.target.value)} />
            <Textarea label={t('coaching.checkIn.struggles')} placeholder={t('coaching.checkIn.missed_sessions_low_energy_an_exercise')} maxLength={1000} value={struggles} onChange={(e) => setStruggles(e.target.value)} />
            <Textarea label={t('coaching.checkIn.anything_else_for_your_coach')} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <p className="text-xs text-muted mt-2">{t('coaching.checkIn.describe_how_things_feel_not_a')}</p>
          {error && (
            <p role="alert" className="text-sm text-danger mt-2">
              {error}
            </p>
          )}
          <div className="flex justify-end mt-3">
            <Button type="submit" variant="primary" icon={<Send className="size-4" />} loading={busy} disabled={empty || !!bwError || !ok || (r != null && !w.ok)}>
              {t('coaching.checkIn.send_check_in')}
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
