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
import { useT } from '@/i18n';
import { alive, deleteRecord, newRecord, saveRecord, StorageWriteError } from '@/db/repo';
import { socialApi } from '@/backend/social';
import type { ActivityLog, ActivityTemplate, ActivityType, DistanceUnit, Intensity } from '@/domain/types';
import {
  ACTIVITY_TYPES, activityLabel, activityTypeInfo, epochToZonedTime, estimateEnergyKcal, hasField, hmsToSec, paceOrSpeed,
  energyEstimateNote, splitHms, validateActivity, zonedTimeToEpoch,
} from '@/domain/activities';
import { formatDistance, fromMeters, round, toMeters } from '@/domain/units';
import { formatMinutes, todayISO } from '@/lib/dates';
import { ActivityIcon } from './icons';

const M_PER_FT = 0.3048;
type EnergySource = NonNullable<ActivityLog['energySource']>;
const ENERGY_SOURCES = [
  { value: 'device', labelKey: 'activities.form.my_device' },
  { value: 'user', labelKey: 'activities.form.my_estimate' },
  { value: 'estimate', labelKey: 'activities.form.approx_calc' },
] as const satisfies readonly { value: EnergySource; labelKey: string }[];

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
  const { t, tp } = useT();
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
    const typeParam = params.get('type') as ActivityType | null;
    if (typeParam && ACTIVITY_TYPES.some((x) => x.type === typeParam)) f.type = typeParam;
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

  const applyTemplate = (tpl: ActivityTemplate) => {
    setForm((f) => {
      const base = f ?? emptyForm(today);
      const next: FormState = { ...base, type: tpl.type };
      if (tpl.durationSec) Object.assign(next, splitHms(tpl.durationSec));
      if (tpl.distanceM != null) next.distance = round(fromMeters(tpl.distanceM, du), 3);
      if (tpl.type === 'custom') next.customName = tpl.name;
      return next;
    });
    setPickTpl(false);
    toast.show(t('activities.form.started_from_x', { name: tpl.name }), { tone: 'success' });
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
    if (form.date > today) errs.date = t('activities.form.dateInFuture');
    if (Object.keys(errs).length) {
      setErrors(errs);
      toast.show(t('activities.form.check_the_highlighted_fields'), { tone: 'warn' });
      return;
    }
    const tz = existing?.timeZone ?? settings.timeZone;
    const startedAt = form.time ? zonedTimeToEpoch(form.date, form.time, tz) : undefined;
    setSaving(true);
    try {
      if (editing && existing) {
        const rec: ActivityLog = { ...existing, ...input, timeZone: tz, startedAt };
        await saveRecord('activities', rec, db);
        toast.show(t('activities.form.activity_updated'), { tone: 'success' });
        nav(-1);
      } else {
        const rec = newRecord<Omit<ActivityLog, 'id' | 'createdAt' | 'updatedAt'>>({ ...input, timeZone: tz, startedAt });
        await saveRecord('activities', rec, db);
        nav(`/train/summary/${rec.id}?kind=activity`, { replace: true });
      }
    } catch (e) {
      toast.show(e instanceof StorageWriteError ? e.message : t('activities.form.couldnt_save_the_activity_please_try'), { tone: 'error' });
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
      toast.show(t('activities.form.template_saved'), { tone: 'success' });
    } catch (e) {
      toast.show(e instanceof StorageWriteError ? e.message : t('activities.form.couldnt_save_the_template'), { tone: 'error' });
    }
  };

  const onDelete = async () => {
    if (!existing) return;
    setDeleting(true);
    try {
      await deleteRecord('activities', existing.id, db);
    } catch (e) {
      setDeleting(false);
      toast.show(e instanceof StorageWriteError ? e.message : t('activities.form.couldnt_delete_the_activity'), { tone: 'error' });
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
    toast.show(failed ? t('activities.form.activity_deleted_the_shared_post_couldnt') : t('activities.form.activity_deleted'), { tone: failed ? 'warn' : 'success' });
    nav(-1);
  };

  const onEstimate = () => {
    if (!form) return;
    const r = estimateEnergyKcal({ type: form.type, intensity: form.intensity || undefined, durationSec, weightKg: latestBw?.value });
    if (!r) return;
    setForm({ ...form, energy: r.kcal, energySource: 'estimate' });
    setEstimateNote(t('activities.form.estimateNote', { kcal: r.kcal, met: r.met, weight: round(latestBw!.value, 1), hours: round(durationSec / 3600, 2), note: energyEstimateNote() }));
  };

  const back = (
    <IconButton label={t('common.back')} onClick={() => nav(-1)}>
      <ChevronLeft className="size-6" />
    </IconButton>
  );
  const title = editing ? t('summary.editActivity') : t('today.logActivity');

  if (editing && existing === undefined) return <Page title={title} back={back}><Spinner /></Page>;
  if (editing && (existing === null || existing?.deletedAt))
    return (
      <Page title={title} back={back}>
        <EmptyState title={t('summary.activityNotFound')} body={t('activities.form.it_may_have_been_deleted_on')} action={<Button onClick={() => nav('/train')}>{t('workout.goToTrain')}</Button>} />
      </Page>
    );
  if (!form || !info) return <Page title={title} back={back}><Spinner /></Page>;

  const hrOk = hasField(form.type, 'hr');

  return (
    <Page title={title} back={back}>
      {!editing && (
        <div className="flex gap-2 mb-2">
          <Button size="sm" variant="outline" icon={<FileDown className="size-4" />} onClick={() => setPickTpl(true)}>
            {t('activities.form.start_from_template')}
          </Button>
          <Button size="sm" variant="ghost" icon={<Timer className="size-4" />} onClick={() => nav('/train/intervals')}>
            {t('today.intervalTimer')}
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
        <SectionTitle id="type-label">{t('train.historyActivity')}</SectionTitle>
        <div role="radiogroup" aria-labelledby="type-label" className="grid grid-cols-4 gap-2">
          {ACTIVITY_TYPES.map((at) => {
            const on = at.type === form.type;
            return (
              <button
                key={at.type}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => set('type', at.type)}
                className={cx(
                  'flex flex-col items-center justify-center gap-1 rounded-xl border min-h-16 px-1 py-2 text-[11px] leading-tight text-center transition-colors',
                  on ? 'bg-accent-soft border-accent text-accent font-semibold' : 'border-line bg-surface text-ink hover:bg-surface-2',
                )}
              >
                <ActivityIcon type={at.type} />
                {at.label}
              </button>
            );
          })}
        </div>
        {form.type === 'custom' && (
          <Input className="mt-3" label={t('activities.form.activity_name')} value={form.customName} onChange={(e) => set('customName', e.target.value)} maxLength={60} placeholder={t('activities.form.e_g_climbing')} error={errors.customName} />
        )}

        <SectionTitle>{t('activities.form.when')}</SectionTitle>
        <Card className="p-4 grid grid-cols-2 gap-3">
          <Input label={t('progress.date')} type="date" value={form.date} max={today} onChange={(e) => set('date', e.target.value)} error={errors.date} />
          <Input label={t('activities.form.start_time')} hint={t('common.optional')} type="time" value={form.time} onChange={(e) => set('time', e.target.value)} />
        </Card>

        <SectionTitle>{t('program.effort')}</SectionTitle>
        <Card className="p-4 flex flex-col gap-4">
          <fieldset>
            <legend className="text-sm font-medium mb-1.5">{t('workout.share.duration')}</legend>
            <div className="grid grid-cols-3 gap-2">
              <NumberInput ariaLabel={t('activities.form.hours')} value={form.h} onChange={(v) => set('h', v)} decimals={false} min={0} max={24} suffix="h" />
              <NumberInput ariaLabel={t('program.minutes')} value={form.m} onChange={(v) => set('m', v)} decimals={false} min={0} max={59} suffix="min" />
              <NumberInput ariaLabel={t('workout.seconds')} value={form.s} onChange={(v) => set('s', v)} decimals={false} min={0} max={59} suffix="s" />
            </div>
            {errors.durationSec ? (
              <p className="text-xs text-danger mt-1.5" role="alert">{errors.durationSec}</p>
            ) : (
              <p className="text-xs text-muted mt-1.5">{durationSec > 0 ? formatMinutes(durationSec) : t('activities.form.between_1_minute_and_24_hours')}</p>
            )}
          </fieldset>

          {(hasField(form.type, 'distance') || hasField(form.type, 'elevation')) && (
            <div className="grid grid-cols-2 gap-3">
              {hasField(form.type, 'distance') && (
                <NumberInput label={t('workout.share.distance')} hint={t('common.optional')} value={form.distance} onChange={(v) => set('distance', v)} min={0} suffix={du} error={errors.distanceM} />
              )}
              {hasField(form.type, 'elevation') && (
                <NumberInput label={t('activities.form.elevation_gain')} hint={t('common.optional')} value={form.elevation} onChange={(v) => set('elevation', v)} decimals={false} min={0} suffix={elevUnit(du)} error={errors.elevationM} />
              )}
            </div>
          )}

          {info.paceMode && (
            <div aria-live="polite" className="rounded-xl bg-surface-2 px-3 py-2.5 flex items-center justify-between">
              <span className="text-sm text-muted">{info.paceMode === 'speed' ? t('activities.form.average_speed') : info.paceMode === 'per_100m' ? t('activities.form.pace_per_100_m') : info.paceMode === 'per_500m' ? t('activities.form.split_per_500_m') : t('activities.form.average_pace')}</span>
              <span className="text-base font-semibold tabular">{preview ? preview.text : '–'}</span>
            </div>
          )}

          <Field label={t('activities.form.intensity')} hint={t('activities.form.how_hard_it_felt_overall_optional')}>
            <Segmented
              label={t('activities.form.intensity')}
              value={form.intensity}
              onChange={(v) => set('intensity', v)}
              options={[
                { value: '', label: t('activities.form.not_set') },
                { value: 'easy', label: t('program.easy') },
                { value: 'moderate', label: t('program.moderate') },
                { value: 'hard', label: t('program.hard') },
              ]}
            />
          </Field>

          {hrOk && (
            <div className="grid grid-cols-2 gap-3">
              <NumberInput label={t('activities.form.avg_heart_rate')} hint={t('common.optional')} value={form.avgHr} onChange={(v) => set('avgHr', v)} decimals={false} suffix="bpm" error={errors.avgHr} />
              <NumberInput label={t('activities.form.max_heart_rate')} hint={t('common.optional')} value={form.maxHr} onChange={(v) => set('maxHr', v)} decimals={false} suffix="bpm" error={errors.maxHr} />
            </div>
          )}
        </Card>

        <SectionTitle>{t('activities.form.energy_optional')}</SectionTitle>
        <Card className="p-4 flex flex-col gap-3">
          <div className="flex items-end gap-2">
            <NumberInput
              className="flex-1"
              label={
                <span className="inline-flex items-center gap-2">
                  {t('activities.form.energy')} {form.energy != null && form.energySource === 'estimate' && <Badge tone="warn">{t('activities.form.approximate')}</Badge>}
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
            <Field label={t('activities.form.where_is_this_number_from')}>
              <Segmented
                label={t('activities.form.energy_source')}
                value={form.energySource}
                onChange={(v) => set('energySource', v)}
                options={ENERGY_SOURCES.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
                size="sm"
              />
            </Field>
          )}
          {latestBw ? (
            <Button size="sm" variant="outline" icon={<Calculator className="size-4" />} onClick={onEstimate} disabled={durationSec < 60} className="self-start">
              {t('activities.form.calculate_an_approximate_value')}
            </Button>
          ) : (
            <p className="text-xs text-muted">{t('activities.form.to_calculate_an_approximate_value_add')}</p>
          )}
          {estimateNote && <Notice tone="warn">{estimateNote}</Notice>}
          <p className="text-xs text-muted">{t('activities.form.energy_figures_are_always_approximate_and')}</p>
        </Card>

        <SectionTitle>{t('workout.custom.notes')}</SectionTitle>
        <Textarea aria-label={t('workout.custom.notes')} value={form.notes} onChange={(e) => set('notes', e.target.value)} maxLength={2000} placeholder={t('activities.form.route_how_it_felt_conditions')} error={errors.notes} />

        <div className="flex flex-col gap-2 mt-6">
          <Button type="submit" variant="primary" size="lg" block loading={saving}>
            {editing ? t('workout.custom.saveChanges') : t('activities.form.save_activity')}
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
            {t('summary.saveTemplate')}
          </Button>
          {editing && (
            <Button variant="danger" block icon={<Trash2 className="size-4" />} onClick={() => setConfirmDelete(true)}>
              {t('activities.form.delete_activity')}
            </Button>
          )}
        </div>
      </form>

      <Sheet open={pickTpl} onClose={() => setPickTpl(false)} title={t('activities.form.start_from_template')}>
        {templates.length === 0 ? (
          <EmptyState title={t('activities.form.no_templates_yet')} body={t('activities.form.fill_in_an_activity_and_choose')} />
        ) : (
          <ul className="-mx-5 divide-y divide-line">
            {templates.map((tpl) => (
              <li key={tpl.id} className="flex items-center pr-3">
                <ListRow
                  className="flex-1"
                  left={<ActivityIcon type={tpl.type} />}
                  title={tpl.name}
                  subtitle={[
                    activityLabel({ type: tpl.type }),
                    tpl.durationSec ? formatMinutes(tpl.durationSec) : null,
                    tpl.distanceM ? formatDistance(tpl.distanceM, du) : null,
                    tpl.intervals?.length ? tp('activities.form.intervalSteps', tpl.intervals.length) : null,
                  ].filter(Boolean).join(' · ')}
                  onClick={() => applyTemplate(tpl)}
                />
                {tpl.intervals?.length ? (
                  <IconButton label={t('activities.form.open_x_in_interval_timer', { name: tpl.name })} onClick={() => nav(`/train/intervals?template=${tpl.id}`)}>
                    <Timer className="size-5" />
                  </IconButton>
                ) : null}
                <IconButton
                  label={t('activities.form.delete_template_x', { name: tpl.name })}
                  onClick={async () => {
                    await deleteRecord('activity_templates', tpl.id, db);
                    toast.show(t('activities.form.template_deleted'));
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
        title={t('summary.saveTemplate')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setSaveTpl(false)}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={onSaveTemplate} disabled={!tplName.trim()}>{t('activities.form.save_template')}</Button>
          </>
        }
      >
        <p className="text-sm text-muted mb-3">
          {durationSec && distanceM
            ? t('activities.form.savesTypeDurationDistance')
            : durationSec
              ? t('activities.form.savesTypeDuration')
              : distanceM
                ? t('activities.form.savesTypeDistance')
                : t('activities.form.saves_the_activity_type')}
        </p>
        <Input label={t('activities.form.template_name')} value={tplName} onChange={(e) => setTplName(e.target.value)} maxLength={60} autoFocus />
      </Sheet>

      <ConfirmDialog
        open={confirmDelete}
        title={t('activities.form.delete_this_activity')}
        body={t('activities.form.it_will_be_removed_from_your')}
        confirmLabel={t('common.delete')}
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
              label={existing.sharedPostIds.length > 1 ? t('activities.form.also_delete_the_shared_posts') : t('activities.form.also_delete_the_shared_post')}
              description={t('activities.form.friends_will_no_longer_see_it')}
            />
          </div>
        )}
      </ConfirmDialog>
    </Page>
  );
}
