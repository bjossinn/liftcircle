/* Manual activity logging: create (/train/activity/new) and edit (/train/activity/:id). */
import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { BookmarkPlus, Calculator, ChevronLeft, FileDown, Timer, Trash2 } from 'lucide-react';
import {
  Badge, Button, Card, ConfirmDialog, EmptyState, Field, IconButton, Input, ListRow, Notice, NumberInput, Page, Segmented, SectionTitle,
  Sheet, Spinner, Textarea, Toggle, cx,
} from '@/components/ui';
import { useToast } from '@/components/toast';
import { useApp } from '@/state/app';
import { alive, deleteRecord, newRecord, saveRecord, StorageWriteError } from '@/db/repo';
import { socialApi } from '@/backend/social';
import type { ActivityLog, ActivityTemplate, ActivityType, DistanceUnit, Intensity } from '@/domain/types';
import {
  ACTIVITY_TYPES, ENERGY_ESTIMATE_NOTE, activityLabel, activityTypeInfo, epochToZonedTime, estimateEnergyKcal, hasField, hmsToSec, paceOrSpeed,
  splitHms, validateActivity, zonedTimeToEpoch,
} from '@/domain/activities';
import { formatDistance, fromMeters, round, toMeters } from '@/domain/units';
import { formatMinutes, todayISO } from '@/lib/dates';
import { ActivityIcon } from './icons';

const M_PER_FT = 0.3048;
type EnergySource = NonNullable<ActivityLog['energySource']>;
const ENERGY_SOURCES: { value: EnergySource; label: string }[] = [
  { value: 'device', label: 'My device' },
  { value: 'user', label: 'My estimate' },
  { value: 'estimate', label: 'Approx. calc' },
];

interface FormState {
  type: ActivityType;
  customName: string;
  date: string;
  time: string;
  h: number | null;
  m: number | null;
  s: number | null;
  distance: number | null; // user distance unit
  elevation: number | null; // m (km users) or ft (mi users)
  avgHr: number | null;
  maxHr: number | null;
  intensity: Intensity | '';
  energy: number | null;
  energySource: EnergySource;
  notes: string;
}

const elevUnit = (du: DistanceUnit) => (du === 'km' ? 'm' : 'ft');
const toElevM = (v: number, du: DistanceUnit) => (du === 'km' ? v : v * M_PER_FT);
const fromElevM = (m: number, du: DistanceUnit) => (du === 'km' ? round(m, 0) : round(m / M_PER_FT, 0));

function emptyForm(today: string): FormState {
  return { type: 'run', customName: '', date: today, time: '', h: 0, m: 30, s: 0, distance: null, elevation: null, avgHr: null, maxHr: null, intensity: '', energy: null, energySource: 'device', notes: '' };
}

function formFromActivity(a: ActivityLog, du: DistanceUnit): FormState {
  const { h, m, s } = splitHms(a.durationSec);
  return {
    type: a.type,
    customName: a.customName ?? '',
    date: a.date,
    time: a.startedAt ? epochToZonedTime(a.startedAt, a.timeZone) : '',
    h, m, s,
    distance: a.distanceM != null ? round(fromMeters(a.distanceM, du), 3) : null,
    elevation: a.elevationM != null ? fromElevM(a.elevationM, du) : null,
    avgHr: a.avgHr ?? null,
    maxHr: a.maxHr ?? null,
    intensity: a.intensity ?? '',
    energy: a.energyKcal ?? null,
    energySource: a.energySource ?? 'device',
    notes: a.notes ?? '',
  };
}

export default function ActivityFormPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const { db, account } = useApp();
  const settings = account.settings;
  const du = settings.units.distance;
  const today = todayISO(settings.timeZone);
  const editing = !!id;

  const existing = useLiveQuery(async () => (id ? ((await db.activities.get(id)) ?? null) : null), [db, id]);
  const templates = alive(useLiveQuery(() => db.activityTemplates.toArray(), [db]) ?? []);
  const latestBw = useLiveQuery(async () => {
    const rows = await db.measurements.where('kind').equals('bodyweight').toArray();
    return alive(rows).sort((a, b) => (a.date < b.date ? 1 : -1))[0] ?? null;
  }, [db]);

  const [form, setForm] = useState<FormState | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [pickTpl, setPickTpl] = useState(false);
  const [saveTpl, setSaveTpl] = useState(false);
  const [tplName, setTplName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [alsoDeletePosts, setAlsoDeletePosts] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [estimateNote, setEstimateNote] = useState<string | null>(null);

  // Initialise the form once (from the record when editing, from query params when new).
  useEffect(() => {
    if (form) return;
    if (editing) {
      if (existing) setForm(formFromActivity(existing, du));
      return;
    }
    const f = emptyForm(today);
    const t = params.get('type') as ActivityType | null;
    if (t && ACTIVITY_TYPES.some((x) => x.type === t)) f.type = t;
    const dur = Number(params.get('duration'));
    if (dur > 0) Object.assign(f, splitHms(dur));
    const notes = params.get('notes');
    if (notes) f.notes = notes.slice(0, 2000);
    const d = params.get('date');
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today) f.date = d;
    setForm(f);
  }, [form, editing, existing, du, today, params]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setForm((f) => (f ? { ...f, [k]: v } : f));
    setErrors((e) => {
      if (!Object.keys(e).length) return e;
      const n = { ...e };
      delete n[k as string];
      if (k === 'distance') delete n.distanceM;
      if (k === 'elevation') delete n.elevationM;
      if (k === 'h' || k === 'm' || k === 's') delete n.durationSec;
      if (k === 'energy') delete n.energyKcal;
      return n;
    });
  };

  const durationSec = form ? hmsToSec(form.h, form.m, form.s) : 0;
  const distanceM = form && form.distance != null && hasField(form.type, 'distance') ? toMeters(form.distance, du) : undefined;
  const preview = form ? paceOrSpeed({ type: form.type, distanceM, durationSec }, du) : null;
  const info = form ? activityTypeInfo(form.type) : null;

  const applyTemplate = (t: ActivityTemplate) => {
    setForm((f) => {
      const base = f ?? emptyForm(today);
      const next: FormState = { ...base, type: t.type };
      if (t.durationSec) Object.assign(next, splitHms(t.durationSec));
      if (t.distanceM != null) next.distance = round(fromMeters(t.distanceM, du), 3);
      if (t.type === 'custom') next.customName = t.name;
      return next;
    });
    setPickTpl(false);
    toast.show(`Started from “${t.name}”`, { tone: 'success' });
  };

  const buildInput = (f: FormState) => ({
    type: f.type,
    customName: f.type === 'custom' ? f.customName.trim() : undefined,
    date: f.date,
    durationSec,
    distanceM,
    elevationM: f.elevation != null && hasField(f.type, 'elevation') ? toElevM(f.elevation, du) : undefined,
    avgHr: f.avgHr ?? undefined,
    maxHr: f.maxHr ?? undefined,
    intensity: f.intensity || undefined,
    energyKcal: f.energy ?? undefined,
    energySource: f.energy != null ? f.energySource : undefined,
    notes: f.notes.trim() || undefined,
  });

  const onSave = async () => {
    if (!form) return;
    const input = buildInput(form);
    const v = validateActivity(input);
    const errs: Record<string, string> = v.ok ? {} : { ...v.errors };
    if (form.date > today) errs.date = 'The date can’t be in the future';
    if (Object.keys(errs).length) {
      setErrors(errs);
      toast.show('Check the highlighted fields', { tone: 'warn' });
      return;
    }
    const tz = existing?.timeZone ?? settings.timeZone;
    const startedAt = form.time ? zonedTimeToEpoch(form.date, form.time, tz) : undefined;
    setSaving(true);
    try {
      if (editing && existing) {
        const rec: ActivityLog = { ...existing, ...input, timeZone: tz, startedAt };
        await saveRecord('activities', rec, db);
        toast.show('Activity updated', { tone: 'success' });
        nav(-1);
      } else {
        const rec = newRecord<Omit<ActivityLog, 'id' | 'createdAt' | 'updatedAt'>>({ ...input, timeZone: tz, startedAt });
        await saveRecord('activities', rec, db);
        nav(`/train/summary/${rec.id}?kind=activity`, { replace: true });
      }
    } catch (e) {
      toast.show(e instanceof StorageWriteError ? e.message : 'Couldn’t save the activity. Please try again.', { tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const onSaveTemplate = async () => {
    if (!form) return;
    const name = tplName.trim();
    if (!name) return;
    try {
      await saveRecord(
        'activity_templates',
        newRecord<Omit<ActivityTemplate, 'id' | 'createdAt' | 'updatedAt'>>({ name, type: form.type, durationSec: durationSec || undefined, distanceM }),
        db,
      );
      setSaveTpl(false);
      toast.show('Template saved', { tone: 'success' });
    } catch (e) {
      toast.show(e instanceof StorageWriteError ? e.message : 'Couldn’t save the template', { tone: 'error' });
    }
  };

  const onDelete = async () => {
    if (!existing) return;
    setDeleting(true);
    try {
      await deleteRecord('activities', existing.id, db);
    } catch (e) {
      setDeleting(false);
      toast.show(e instanceof StorageWriteError ? e.message : 'Couldn’t delete the activity', { tone: 'error' });
      return;
    }
    const posts = existing.sharedPostIds ?? [];
    let failed = 0;
    if (alsoDeletePosts && posts.length) {
      for (const pid of posts) {
        try {
          await socialApi.deletePost(pid);
        } catch {
          failed++;
        }
      }
    }
    setDeleting(false);
    setConfirmDelete(false);
    toast.show(failed ? 'Activity deleted. The shared post couldn’t be removed right now. You can delete it from the feed.' : 'Activity deleted', { tone: failed ? 'warn' : 'success' });
    nav(-1);
  };

  const onEstimate = () => {
    if (!form) return;
    const r = estimateEnergyKcal({ type: form.type, intensity: form.intensity || undefined, durationSec, weightKg: latestBw?.value });
    if (!r) return;
    setForm({ ...form, energy: r.kcal, energySource: 'estimate' });
    setEstimateNote(`About ${r.kcal} kcal (MET ${r.met} × ${round(latestBw!.value, 1)} kg × ${round(durationSec / 3600, 2)} h). ${ENERGY_ESTIMATE_NOTE}`);
  };

  const back = (
    <IconButton label="Back" onClick={() => nav(-1)}>
      <ChevronLeft className="size-6" />
    </IconButton>
  );
  const title = editing ? 'Edit activity' : 'Log activity';

  if (editing && existing === undefined) return <Page title={title} back={back}><Spinner /></Page>;
  if (editing && (existing === null || existing?.deletedAt))
    return (
      <Page title={title} back={back}>
        <EmptyState title="Activity not found" body="It may have been deleted on this or another device." action={<Button onClick={() => nav('/train')}>Go to Train</Button>} />
      </Page>
    );
  if (!form || !info) return <Page title={title} back={back}><Spinner /></Page>;

  const hrOk = hasField(form.type, 'hr');

  return (
    <Page title={title} back={back}>
      {!editing && (
        <div className="flex gap-2 mb-2">
          <Button size="sm" variant="outline" icon={<FileDown className="size-4" />} onClick={() => setPickTpl(true)}>
            Start from template
          </Button>
          <Button size="sm" variant="ghost" icon={<Timer className="size-4" />} onClick={() => nav('/train/intervals')}>
            Interval timer
          </Button>
        </div>
      )}

      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void onSave();
        }}
      >
        <SectionTitle id="type-label">Activity</SectionTitle>
        <div role="radiogroup" aria-labelledby="type-label" className="grid grid-cols-4 gap-2">
          {ACTIVITY_TYPES.map((t) => {
            const on = t.type === form.type;
            return (
              <button
                key={t.type}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => set('type', t.type)}
                className={cx(
                  'flex flex-col items-center justify-center gap-1 rounded-xl border min-h-16 px-1 py-2 text-[11px] leading-tight text-center transition-colors',
                  on ? 'bg-accent-soft border-accent text-accent font-semibold' : 'border-line bg-surface text-ink hover:bg-surface-2',
                )}
              >
                <ActivityIcon type={t.type} />
                {t.label}
              </button>
            );
          })}
        </div>
        {form.type === 'custom' && (
          <Input className="mt-3" label="Activity name" value={form.customName} onChange={(e) => set('customName', e.target.value)} maxLength={60} placeholder="e.g. Climbing" error={errors.customName} />
        )}

        <SectionTitle>When</SectionTitle>
        <Card className="p-4 grid grid-cols-2 gap-3">
          <Input label="Date" type="date" value={form.date} max={today} onChange={(e) => set('date', e.target.value)} error={errors.date} />
          <Input label="Start time" hint="Optional" type="time" value={form.time} onChange={(e) => set('time', e.target.value)} />
        </Card>

        <SectionTitle>Effort</SectionTitle>
        <Card className="p-4 flex flex-col gap-4">
          <fieldset>
            <legend className="text-sm font-medium mb-1.5">Duration</legend>
            <div className="grid grid-cols-3 gap-2">
              <NumberInput ariaLabel="Hours" value={form.h} onChange={(v) => set('h', v)} decimals={false} min={0} max={24} suffix="h" />
              <NumberInput ariaLabel="Minutes" value={form.m} onChange={(v) => set('m', v)} decimals={false} min={0} max={59} suffix="min" />
              <NumberInput ariaLabel="Seconds" value={form.s} onChange={(v) => set('s', v)} decimals={false} min={0} max={59} suffix="s" />
            </div>
            {errors.durationSec ? (
              <p className="text-xs text-danger mt-1.5" role="alert">{errors.durationSec}</p>
            ) : (
              <p className="text-xs text-muted mt-1.5">{durationSec > 0 ? formatMinutes(durationSec) : 'Between 1 minute and 24 hours'}</p>
            )}
          </fieldset>

          {(hasField(form.type, 'distance') || hasField(form.type, 'elevation')) && (
            <div className="grid grid-cols-2 gap-3">
              {hasField(form.type, 'distance') && (
                <NumberInput label="Distance" hint="Optional" value={form.distance} onChange={(v) => set('distance', v)} min={0} suffix={du} error={errors.distanceM} />
              )}
              {hasField(form.type, 'elevation') && (
                <NumberInput label="Elevation gain" hint="Optional" value={form.elevation} onChange={(v) => set('elevation', v)} decimals={false} min={0} suffix={elevUnit(du)} error={errors.elevationM} />
              )}
            </div>
          )}

          {info.paceMode && (
            <div aria-live="polite" className="rounded-xl bg-surface-2 px-3 py-2.5 flex items-center justify-between">
              <span className="text-sm text-muted">{info.paceMode === 'speed' ? 'Average speed' : info.paceMode === 'per_100m' ? 'Pace per 100 m' : info.paceMode === 'per_500m' ? 'Split per 500 m' : 'Average pace'}</span>
              <span className="text-base font-semibold tabular">{preview ? preview.text : '–'}</span>
            </div>
          )}

          <Field label="Intensity" hint="How hard it felt overall (optional)">
            <Segmented
              label="Intensity"
              value={form.intensity}
              onChange={(v) => set('intensity', v)}
              options={[
                { value: '', label: 'Not set' },
                { value: 'easy', label: 'Easy' },
                { value: 'moderate', label: 'Moderate' },
                { value: 'hard', label: 'Hard' },
              ]}
            />
          </Field>

          {hrOk && (
            <div className="grid grid-cols-2 gap-3">
              <NumberInput label="Avg heart rate" hint="Optional" value={form.avgHr} onChange={(v) => set('avgHr', v)} decimals={false} suffix="bpm" error={errors.avgHr} />
              <NumberInput label="Max heart rate" hint="Optional" value={form.maxHr} onChange={(v) => set('maxHr', v)} decimals={false} suffix="bpm" error={errors.maxHr} />
            </div>
          )}
        </Card>

        <SectionTitle>Energy (optional)</SectionTitle>
        <Card className="p-4 flex flex-col gap-3">
          <div className="flex items-end gap-2">
            <NumberInput
              className="flex-1"
              label={
                <span className="inline-flex items-center gap-2">
                  Energy {form.energy != null && form.energySource === 'estimate' && <Badge tone="warn">Approximate</Badge>}
                </span>
              }
              value={form.energy}
              onChange={(v) => {
                setEstimateNote(null);
                setForm((f) => (f ? { ...f, energy: v, energySource: f.energySource === 'estimate' && v != null ? 'user' : f.energySource } : f));
                setErrors((e) => ({ ...e, energyKcal: '' }));
              }}
              decimals={false}
              min={0}
              suffix="kcal"
              error={errors.energyKcal || null}
            />
          </div>
          {form.energy != null && (
            <Field label="Where is this number from?">
              <Segmented label="Energy source" value={form.energySource} onChange={(v) => set('energySource', v)} options={ENERGY_SOURCES} size="sm" />
            </Field>
          )}
          {latestBw ? (
            <Button size="sm" variant="outline" icon={<Calculator className="size-4" />} onClick={onEstimate} disabled={durationSec < 60} className="self-start">
              Calculate an approximate value
            </Button>
          ) : (
            <p className="text-xs text-muted">To calculate an approximate value, add a bodyweight entry in Progress. You can always type your own number.</p>
          )}
          {estimateNote && <Notice tone="warn">{estimateNote}</Notice>}
          <p className="text-xs text-muted">Energy figures are always approximate and are never added to your nutrition targets automatically.</p>
        </Card>

        <SectionTitle>Notes</SectionTitle>
        <Textarea aria-label="Notes" value={form.notes} onChange={(e) => set('notes', e.target.value)} maxLength={2000} placeholder="Route, how it felt, conditions…" error={errors.notes} />

        <div className="flex flex-col gap-2 mt-6">
          <Button type="submit" variant="primary" size="lg" block loading={saving}>
            {editing ? 'Save changes' : 'Save activity'}
          </Button>
          <Button
            variant="ghost"
            block
            icon={<BookmarkPlus className="size-4" />}
            onClick={() => {
              setTplName(form.type === 'custom' && form.customName.trim() ? form.customName.trim() : `${activityLabel(form)}${durationSec ? ` · ${formatMinutes(durationSec)}` : ''}`);
              setSaveTpl(true);
            }}
          >
            Save as template
          </Button>
          {editing && (
            <Button variant="danger" block icon={<Trash2 className="size-4" />} onClick={() => setConfirmDelete(true)}>
              Delete activity
            </Button>
          )}
        </div>
      </form>

      <Sheet open={pickTpl} onClose={() => setPickTpl(false)} title="Start from template">
        {templates.length === 0 ? (
          <EmptyState title="No templates yet" body="Fill in an activity and choose “Save as template” to reuse it next time." />
        ) : (
          <ul className="-mx-5 divide-y divide-line">
            {templates.map((t) => (
              <li key={t.id} className="flex items-center pr-3">
                <ListRow
                  className="flex-1"
                  left={<ActivityIcon type={t.type} />}
                  title={t.name}
                  subtitle={[
                    activityLabel({ type: t.type }),
                    t.durationSec ? formatMinutes(t.durationSec) : null,
                    t.distanceM ? formatDistance(t.distanceM, du) : null,
                    t.intervals?.length ? `${t.intervals.length} interval steps` : null,
                  ].filter(Boolean).join(' · ')}
                  onClick={() => applyTemplate(t)}
                />
                {t.intervals?.length ? (
                  <IconButton label={`Open ${t.name} in interval timer`} onClick={() => nav(`/train/intervals?template=${t.id}`)}>
                    <Timer className="size-5" />
                  </IconButton>
                ) : null}
                <IconButton
                  label={`Delete template ${t.name}`}
                  onClick={async () => {
                    await deleteRecord('activity_templates', t.id, db);
                    toast.show('Template deleted');
                  }}
                >
                  <Trash2 className="size-5 text-danger" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Sheet>

      <Sheet
        open={saveTpl}
        onClose={() => setSaveTpl(false)}
        title="Save as template"
        footer={
          <>
            <Button variant="ghost" onClick={() => setSaveTpl(false)}>Cancel</Button>
            <Button variant="primary" onClick={onSaveTemplate} disabled={!tplName.trim()}>Save template</Button>
          </>
        }
      >
        <p className="text-sm text-muted mb-3">Saves the activity type{durationSec ? ', duration' : ''}{distanceM ? ' and distance' : ''} so you can start from it next time.</p>
        <Input label="Template name" value={tplName} onChange={(e) => setTplName(e.target.value)} maxLength={60} autoFocus />
      </Sheet>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this activity?"
        body="It will be removed from your history, weekly totals and progress charts on all your devices."
        confirmLabel="Delete"
        danger
        busy={deleting}
        onConfirm={onDelete}
        onCancel={() => setConfirmDelete(false)}
      >
        {!!existing?.sharedPostIds?.length && (
          <div className="mt-3">
            <Toggle
              checked={alsoDeletePosts}
              onChange={setAlsoDeletePosts}
              label={existing.sharedPostIds.length > 1 ? 'Also delete the shared posts' : 'Also delete the shared post'}
              description="Friends will no longer see it in their feed."
            />
          </div>
        )}
      </ConfirmDialog>
    </Page>
  );
}
