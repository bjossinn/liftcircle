/**
 * Program building blocks shared by the onboarding result screen and the program editor.
 * All edits are reported through callbacks; callers decide whether that is a local draft
 * change (onboarding) or a new ProgramVersion (program page).
 */
import { useState } from 'react';
import {
  ArrowDown, ArrowUp, CalendarDays, ChevronDown, ChevronUp, Clock, Copy, Dumbbell, Footprints, Pencil, Plus, RefreshCw, Repeat, StretchHorizontal, Trash2,
} from 'lucide-react';
import { Badge, Button, Card, ChipGroup, ConfirmDialog, IconButton, Input, NumberInput, Segmented, Sheet, Textarea } from '@/components/ui';
import { ExercisePicker } from '@/components/ExercisePicker';
import { formatWeight } from '@/domain/units';
import { defaultPrescription, estimateSessionMinutes, WEEK_ORDER } from '@/domain/program/generator';
import { exerciseCue, exerciseNote, prescriptionText, restText, RIR_PLAIN, SESSION_CALIBRATION_TIP, SESSION_WARMUP_TIP } from '@/domain/program/explain';
import { WEEKDAY_SHORT } from '@/lib/dates';
import type { Exercise, Experience, Goal, ID, Prescription, ProgramVersion, SessionTemplate, WeightUnit } from '@/domain/types';
import { ACTIVITY_NAMES } from '@/domain/program/generator';

export const KIND_LABEL: Record<SessionTemplate['kind'], string> = {
  lifting: 'Strength',
  cardio: 'Cardio',
  walk: 'Walk',
  mobility: 'Mobility',
  conditioning: 'Conditioning',
};

export function KindIcon({ kind, className = 'size-4' }: { kind: SessionTemplate['kind']; className?: string }) {
  if (kind === 'walk' || kind === 'cardio') return <Footprints className={className} aria-hidden />;
  if (kind === 'mobility') return <StretchHorizontal className={className} aria-hidden />;
  return <Dumbbell className={className} aria-hidden />;
}

/** Weekly schedule overview ordered from the user's week start. */
export function WeekStrip({ version, weekStart = 1, highlight }: { version: Pick<ProgramVersion, 'schedule' | 'templates'>; weekStart?: 0 | 1; highlight?: number }) {
  const order = weekStart === 1 ? WEEK_ORDER : [0, 1, 2, 3, 4, 5, 6];
  return (
    <ol className="grid grid-cols-7 gap-1" aria-label="Weekly schedule">
      {order.map((d) => {
        const slots = version.schedule.filter((s) => s.weekday === d);
        const names = slots.map((s) => version.templates.find((t) => t.id === s.templateId)).filter(Boolean) as SessionTemplate[];
        const hard = names.some((t) => t.kind === 'lifting' || t.kind === 'conditioning');
        return (
          <li
            key={d}
            className={`rounded-xl border px-1 py-2 text-center min-h-16 flex flex-col items-center gap-1 ${hard ? 'border-accent/40 bg-accent-soft' : names.length ? 'border-line bg-surface-2' : 'border-line'} ${highlight === d ? 'ring-2 ring-accent' : ''}`}
          >
            <span className="text-[11px] font-semibold text-muted">{WEEKDAY_SHORT[d]}</span>
            {names.length ? (
              names.map((t, i) => (
                <span key={i} className="text-[10px] leading-tight text-ink line-clamp-2">
                  {t.name}
                </span>
              ))
            ) : (
              <span className="text-[10px] text-faint">Rest</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function rxSummary(rx: Prescription, ex: Exercise | undefined, unit: WeightUnit): string {
  const parts = [prescriptionText(rx)];
  if (rx.startLoadKg != null) parts.push(`start ${formatWeight(rx.startLoadKg, unit)}`);
  else if (rx.calibrate) parts.push('calibrate');
  if (ex?.unilateral && !rx.durationSec) parts.push('per side');
  return parts.join(' · ');
}

interface SessionCardProps {
  template: SessionTemplate;
  byId: Map<ID, Exercise>;
  catalog: Exercise[];
  unit: WeightUnit;
  /** Weekdays this template is scheduled on. */
  days?: number[];
  editable?: boolean;
  experience?: Experience;
  goal?: Goal;
  onChange?: (t: SessionTemplate, reason: string) => void;
  onRegenerate?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
  onDaysChange?: (days: number[]) => void;
  defaultOpen?: boolean;
  /** Restrict the exercise pickers to these ids (no custom exercises), e.g. for coach-built plans. */
  pickerOnlyIds?: Set<ID>;
  pickerOnlyNote?: string;
}

/** One session with its exercises; optional editing controls. */
export function SessionCard(props: SessionCardProps) {
  const { template: t, byId, catalog, unit, editable, onChange, days } = props;
  const [open, setOpen] = useState(props.defaultOpen ?? true);
  const [editRx, setEditRx] = useState<Prescription | null>(null);
  const [swapFor, setSwapFor] = useState<Prescription | null>(null);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [editDays, setEditDays] = useState(false);
  const [editCardio, setEditCardio] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const commit = (next: SessionTemplate, reason: string) => {
    onChange?.({ ...next, estimatedMinutes: estimateSessionMinutes(next, catalog) }, reason);
  };
  const setExercises = (exercises: Prescription[], reason: string) => commit({ ...t, exercises }, reason);
  const nameOf = (id: ID) => byId.get(id)?.name ?? 'Unknown exercise';

  // Session-level tips replace the same sentence repeated on every exercise row.
  const anyCalibrate = t.exercises.some((rx) => rx.calibrate);
  const anyGenericWarmup = t.kind === 'lifting' && t.exercises.some((rx) => exerciseCue(rx).generic);

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= t.exercises.length) return;
    const list = [...t.exercises];
    [list[i], list[j]] = [list[j], list[i]];
    setExercises(list, `Reordered ${t.name}`);
  };

  return (
    <Card as="article" className="overflow-hidden" aria-label={t.name}>
      <div className="flex items-start gap-3 px-4 pt-3 pb-2">
        <div className="size-9 shrink-0 rounded-xl bg-surface-2 flex items-center justify-center text-accent mt-0.5">
          <KindIcon kind={t.kind} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold leading-tight">{t.name}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <Badge tone={t.kind === 'lifting' ? 'accent' : 'neutral'}>{KIND_LABEL[t.kind]}</Badge>
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3.5" aria-hidden /> ~{t.estimatedMinutes} min
            </span>
            {days && days.length > 0 && (
              <span className="inline-flex items-center gap-1">
                <CalendarDays className="size-3.5" aria-hidden />
                {[...days].sort((a, b) => WEEK_ORDER.indexOf(a) - WEEK_ORDER.indexOf(b)).map((d) => WEEKDAY_SHORT[d]).join(', ')}
              </span>
            )}
          </div>
        </div>
        <IconButton label={open ? `Collapse ${t.name}` : `Expand ${t.name}`} onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? <ChevronUp className="size-5" /> : <ChevronDown className="size-5" />}
        </IconButton>
      </div>

      {open && (
        <div className="px-4 pb-3">
          {t.cardio && (
            <div className="rounded-xl bg-surface-2 px-3 py-2.5 mb-2 text-sm">
              <div className="font-medium">
                {ACTIVITY_NAMES[t.cardio.activity]} · {t.cardio.minutes} min · {t.cardio.intensity}
              </div>
              {t.cardio.notes && <p className="text-muted text-xs mt-1">{t.cardio.notes}</p>}
              {editable && (
                <Button size="sm" variant="ghost" className="mt-1 -ml-2" icon={<Pencil className="size-4" />} onClick={() => setEditCardio(true)}>
                  Edit
                </Button>
              )}
            </div>
          )}

          {t.exercises.length > 0 && (
            <ol className="divide-y divide-line">
              {t.exercises.map((rx, i) => {
                const ex = byId.get(rx.exerciseId);
                const cue = exerciseCue(rx).cue;
                const note = exerciseNote(rx);
                return (
                  <li key={rx.id} className="py-2.5">
                    <div className="flex items-start gap-2">
                      <span className="tabular text-xs text-faint w-5 pt-0.5">{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-medium text-[15px]">{nameOf(rx.exerciseId)}</span>
                          {rx.priority === 1 && <Badge tone="accent">Main</Badge>}
                          {rx.priority === 3 && <Badge>Accessory</Badge>}
                        </div>
                        <p className="text-xs text-muted mt-0.5 tabular">{rxSummary(rx, ex, unit)}</p>
                        {cue && <p className="text-xs text-faint mt-1">{cue}</p>}
                        {note && <p className="text-xs text-muted mt-1">{note}</p>}
                      </div>
                    </div>
                    {editable && (
                      <div className="flex flex-wrap gap-1 mt-1.5 pl-7">
                        <Button size="sm" variant="ghost" icon={<Repeat className="size-4" />} onClick={() => setSwapFor(rx)} aria-label={`Swap ${nameOf(rx.exerciseId)}`}>
                          Swap
                        </Button>
                        <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} onClick={() => setEditRx(rx)} aria-label={`Edit sets and reps for ${nameOf(rx.exerciseId)}`}>
                          Edit
                        </Button>
                        <IconButton size="sm" label={`Move ${nameOf(rx.exerciseId)} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                          <ArrowUp className="size-4" />
                        </IconButton>
                        <IconButton size="sm" label={`Move ${nameOf(rx.exerciseId)} down`} disabled={i === t.exercises.length - 1} onClick={() => move(i, 1)}>
                          <ArrowDown className="size-4" />
                        </IconButton>
                        <IconButton size="sm" label={`Remove ${nameOf(rx.exerciseId)}`} onClick={() => setExercises(t.exercises.filter((x) => x.id !== rx.id), `Removed ${nameOf(rx.exerciseId)}`)}>
                          <Trash2 className="size-4" />
                        </IconButton>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {(anyCalibrate || anyGenericWarmup) && (
            <ul className="mt-1 flex flex-col gap-1 text-xs text-muted">
              {anyGenericWarmup && <li>{SESSION_WARMUP_TIP}</li>}
              {anyCalibrate && <li>{SESSION_CALIBRATION_TIP}</li>}
            </ul>
          )}
          {t.kind === 'lifting' && t.exercises.length === 0 && <p className="text-sm text-muted py-3">No exercises yet. Add the ones you want to train in this session.</p>}

          {t.trimmedExerciseIds && t.trimmedExerciseIds.length > 0 && (
            <p className="text-xs text-muted mt-2">
              Trimmed to fit your time: {t.trimmedExerciseIds.map(nameOf).join(', ')}.
              {editable && ' Add them back with “Add exercise” if you have time.'}
            </p>
          )}

          {editable && (
            <div className="flex flex-wrap gap-2 mt-3">
              {(t.kind === 'lifting' || t.exercises.length > 0) && (
                <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
                  Add exercise
                </Button>
              )}
              <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} onClick={() => setRenaming(true)}>
                Rename
              </Button>
              {props.onDaysChange && (
                <Button size="sm" variant="ghost" icon={<CalendarDays className="size-4" />} onClick={() => setEditDays(true)}>
                  Days
                </Button>
              )}
              {props.onRegenerate && (
                <Button size="sm" variant="ghost" icon={<RefreshCw className="size-4" />} onClick={props.onRegenerate} aria-label={`Shuffle exercises in ${t.name}`}>
                  Shuffle exercises
                </Button>
              )}
              {props.onDuplicate && (
                <Button size="sm" variant="ghost" icon={<Copy className="size-4" />} onClick={props.onDuplicate}>
                  Save to library
                </Button>
              )}
              {props.onDelete && (
                <Button size="sm" variant="ghost" className="text-danger" icon={<Trash2 className="size-4" />} onClick={() => setConfirmDelete(true)}>
                  Delete
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {/* --- sheets */}
      <PrescriptionSheet
        open={!!editRx}
        rx={editRx}
        ex={editRx ? byId.get(editRx.exerciseId) : undefined}
        onClose={() => setEditRx(null)}
        onSave={(next) => {
          setExercises(
            t.exercises.map((x) => (x.id === next.id ? next : x)),
            `Edited ${nameOf(next.exerciseId)} in ${t.name}`,
          );
          setEditRx(null);
        }}
      />
      <ExercisePicker
        open={!!swapFor}
        onClose={() => setSwapFor(null)}
        title={swapFor ? `Swap ${nameOf(swapFor.exerciseId)}` : 'Swap exercise'}
        suggestIds={swapFor ? [...new Set([...swapFor.alternatives, ...(byId.get(swapFor.exerciseId)?.substitutions ?? [])])] : []}
        excludeIds={t.exercises.map((x) => x.exerciseId)}
        onlyIds={props.pickerOnlyIds}
        onlyNote={props.pickerOnlyNote}
        onPick={(ex) => {
          if (!swapFor) return;
          const old = nameOf(swapFor.exerciseId);
          const timed = ex.tracking === 'duration' || ex.tracking === 'distance_time';
          const next: Prescription = {
            ...swapFor,
            exerciseId: ex.id,
            startLoadKg: undefined,
            calibrate: ex.tracking === 'weight_reps' || ex.tracking === 'assisted' ? true : undefined,
            durationSec: timed ? swapFor.durationSec ?? 30 : undefined,
            repMin: timed ? 1 : swapFor.durationSec ? 8 : swapFor.repMin,
            repMax: timed ? 1 : swapFor.durationSec ? 12 : swapFor.repMax,
            alternatives: [...new Set([swapFor.exerciseId, ...swapFor.alternatives.filter((a) => a !== ex.id)])].slice(0, 5),
          };
          setExercises(
            t.exercises.map((x) => (x.id === swapFor.id ? next : x)),
            `Swapped ${old} for ${ex.name}`,
          );
          setSwapFor(null);
        }}
      />
      <ExercisePicker
        open={adding}
        onClose={() => setAdding(false)}
        title={`Add to ${t.name}`}
        excludeIds={t.exercises.map((x) => x.exerciseId)}
        onlyIds={props.pickerOnlyIds}
        onlyNote={props.pickerOnlyNote}
        onPick={(ex) => {
          const slotId = `${t.id}:x${Date.now().toString(36)}`;
          setExercises([...t.exercises, defaultPrescription(ex, slotId, props.experience, props.goal, t.exercises.length === 0 ? 1 : 2)], `Added ${ex.name} to ${t.name}`);
          setAdding(false);
        }}
      />
      <RenameSheet open={renaming} value={t.name} title="Rename session" onClose={() => setRenaming(false)} onSave={(name) => { commit({ ...t, name }, `Renamed ${t.name} to ${name}`); setRenaming(false); }} />
      {props.onDaysChange && (
        <DaysSheet open={editDays} days={days ?? []} title={`Days for ${t.name}`} onClose={() => setEditDays(false)} onSave={(d) => { props.onDaysChange!(d); setEditDays(false); }} />
      )}
      {t.cardio && (
        <CardioSheet open={editCardio} template={t} onClose={() => setEditCardio(false)} onSave={(cardio) => { commit({ ...t, cardio }, `Edited ${t.name}`); setEditCardio(false); }} />
      )}
      {props.onDelete && (
        <ConfirmDialog
          open={confirmDelete}
          title={`Delete ${t.name}?`}
          body="It’s removed from your program (a new version is saved, so you can restore it). Completed workouts stay in your history."
          confirmLabel="Delete session"
          danger
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            props.onDelete!();
          }}
        />
      )}
    </Card>
  );
}

export function PrescriptionSheet({ open, rx, ex, onClose, onSave }: { open: boolean; rx: Prescription | null; ex?: Exercise; onClose: () => void; onSave: (rx: Prescription) => void }) {
  return (
    <Sheet open={open} onClose={onClose} title={ex ? ex.name : 'Edit exercise'}>
      {rx && <PrescriptionForm key={rx.id + rx.exerciseId} rx={rx} ex={ex} onCancel={onClose} onSave={onSave} />}
    </Sheet>
  );
}

function PrescriptionForm({ rx, ex, onSave, onCancel }: { rx: Prescription; ex?: Exercise; onSave: (rx: Prescription) => void; onCancel: () => void }) {
  const [d, setD] = useState<Prescription>(rx);
  const timed = d.durationSec != null || ex?.tracking === 'duration';
  const errors: string[] = [];
  if (d.sets < 1 || d.sets > 10) errors.push('Sets must be between 1 and 10.');
  if (!timed && (d.repMin < 1 || d.repMax < d.repMin || d.repMax > 50)) errors.push('Rep range must be 1–50 with the top at least the bottom.');
  if (timed && (!d.durationSec || d.durationSec < 5 || d.durationSec > 3600)) errors.push('Duration must be 5–3600 seconds.');
  if (d.restSec < 0 || d.restSec > 600) errors.push('Rest must be 0–600 seconds.');
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!errors.length) onSave(d);
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <NumberInput label="Working sets" decimals={false} min={1} max={10} value={d.sets} onChange={(v) => setD({ ...d, sets: v ?? 1 })} />
        <NumberInput label="Rest (seconds)" decimals={false} min={0} max={600} value={d.restSec} onChange={(v) => setD({ ...d, restSec: v ?? 0 })} hint={restText(d.restSec)} />
        {timed ? (
          <NumberInput label="Seconds per set" decimals={false} min={5} max={3600} value={d.durationSec ?? 30} onChange={(v) => setD({ ...d, durationSec: v ?? 30 })} />
        ) : (
          <>
            <NumberInput label="Reps — bottom" decimals={false} min={1} max={50} value={d.repMin} onChange={(v) => setD({ ...d, repMin: v ?? 1 })} />
            <NumberInput label="Reps — top" decimals={false} min={1} max={50} value={d.repMax} onChange={(v) => setD({ ...d, repMax: v ?? d.repMin })} />
          </>
        )}
        <NumberInput label="Target RIR" decimals={false} min={0} max={5} value={d.targetRir} onChange={(v) => setD({ ...d, targetRir: v ?? 2 })} />
      </div>
      <p className="text-xs text-muted">{RIR_PLAIN}</p>
      <div>
        <span className="text-sm font-medium block mb-1.5">Role in the session</span>
        <Segmented
          label="Priority"
          value={d.priority}
          onChange={(v) => setD({ ...d, priority: v })}
          options={[
            { value: 1, label: 'Main' },
            { value: 2, label: 'Secondary' },
            { value: 3, label: 'Accessory' },
          ]}
        />
        <p className="text-xs text-muted mt-1">Accessories are the first to go when a session runs over your time.</p>
      </div>
      <Textarea label="Notes (optional)" value={d.notes ?? ''} maxLength={300} onChange={(e) => setD({ ...d, notes: e.target.value || undefined })} />
      {errors.length > 0 && (
        <ul className="text-xs text-danger" role="alert">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={errors.length > 0}>
          Save
        </Button>
      </div>
    </form>
  );
}

export function RenameSheet({ open, value, title, onClose, onSave }: { open: boolean; value: string; title: string; onClose: () => void; onSave: (v: string) => void }) {
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      {open && <RenameForm value={value} onSave={onSave} onCancel={onClose} />}
    </Sheet>
  );
}
function RenameForm({ value, onSave, onCancel }: { value: string; onSave: (v: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(value);
  const trimmed = v.trim();
  const error = !trimmed ? 'Enter a name.' : trimmed.length > 60 ? 'Keep it under 60 characters.' : null;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!error) onSave(trimmed);
      }}
    >
      <Input label="Name" value={v} autoFocus maxLength={80} onChange={(e) => setV(e.target.value)} error={v !== value ? error : null} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!!error}>
          Save
        </Button>
      </div>
    </form>
  );
}

export function DaysSheet({ open, days, title, onClose, onSave }: { open: boolean; days: number[]; title: string; onClose: () => void; onSave: (d: number[]) => void }) {
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      {open && <DaysForm days={days} onSave={onSave} onCancel={onClose} />}
    </Sheet>
  );
}
function DaysForm({ days, onSave, onCancel }: { days: number[]; onSave: (d: number[]) => void; onCancel: () => void }) {
  const [d, setD] = useState<number[]>(days);
  return (
    <div className="flex flex-col gap-4">
      <ChipGroup label="Weekdays" values={d} onChange={setD} options={WEEK_ORDER.map((w) => ({ value: w, label: WEEKDAY_SHORT[w] }))} />
      <p className="text-xs text-muted">Leave all unselected to keep this session in the program without a fixed day.</p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => onSave(d)}>
          Save
        </Button>
      </div>
    </div>
  );
}

function CardioSheet({ open, template, onClose, onSave }: { open: boolean; template: SessionTemplate; onClose: () => void; onSave: (c: NonNullable<SessionTemplate['cardio']>) => void }) {
  return (
    <Sheet open={open} onClose={onClose} title={`Edit ${template.name}`}>
      {open && template.cardio && <CardioForm cardio={template.cardio} onSave={onSave} onCancel={onClose} />}
    </Sheet>
  );
}
function CardioForm({ cardio, onSave, onCancel }: { cardio: NonNullable<SessionTemplate['cardio']>; onSave: (c: NonNullable<SessionTemplate['cardio']>) => void; onCancel: () => void }) {
  const [c, setC] = useState(cardio);
  const bad = !c.minutes || c.minutes < 5 || c.minutes > 600;
  return (
    <div className="flex flex-col gap-4">
      <NumberInput label="Minutes" decimals={false} min={5} max={600} value={c.minutes} onChange={(v) => setC({ ...c, minutes: v ?? 5 })} error={bad ? 'Choose 5–600 minutes.' : null} />
      <div>
        <span className="text-sm font-medium block mb-1.5">Effort</span>
        <Segmented
          label="Effort"
          value={c.intensity}
          onChange={(v) => setC({ ...c, intensity: v })}
          options={[
            { value: 'easy', label: 'Easy' },
            { value: 'moderate', label: 'Moderate' },
            { value: 'hard', label: 'Hard' },
          ]}
        />
      </div>
      <Textarea label="Notes" value={c.notes} maxLength={300} onChange={(e) => setC({ ...c, notes: e.target.value })} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" disabled={bad} onClick={() => onSave(c)}>
          Save
        </Button>
      </div>
    </div>
  );
}

/** One-line reading guide for prescriptions, shown once above the session list. */
export function PlanLegend() {
  return <p className="text-xs text-muted px-1 -mt-1 mb-2">Sets × reps · RIR = reps left in the tank at the end of each set · rest between sets. Times include warm-up and rest.</p>;
}

/**
 * “Why this plan?” — rationale and warnings, collapsible. When collapsed, the header still says how many
 * trade-offs/safety notes there are, so warnings are never hidden without a visible signal.
 */
export function WhyItFits({ version, defaultOpen = false }: { version: Pick<ProgramVersion, 'rationale' | 'warnings'>; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const n = version.warnings.length;
  return (
    <section aria-labelledby="why-title" className="mt-4">
      <button type="button" className="flex w-full items-center justify-between gap-2 min-h-11 px-1 text-left" aria-expanded={open} aria-controls="why-body" onClick={() => setOpen(!open)}>
        <span className="flex flex-wrap items-center gap-2">
          <h2 id="why-title" className="text-[13px] font-semibold uppercase tracking-wide text-muted">
            Why this plan?
          </h2>
          {n > 0 && (
            <Badge tone="warn">
              {n} {n === 1 ? 'note' : 'notes'} to check
            </Badge>
          )}
        </span>
        {open ? <ChevronUp className="size-4 text-muted" aria-hidden /> : <ChevronDown className="size-4 text-muted" aria-hidden />}
      </button>
      {open && (
        <div id="why-body">
          {n > 0 && (
            <div className="flex flex-col gap-2 mb-3">
              {version.warnings.map((w) => (
                <div key={w} className="rounded-xl border border-warn/30 bg-warn-soft px-3.5 py-2.5 text-sm">
                  {w}
                </div>
              ))}
            </div>
          )}
          <Card className="px-4 py-3">
            <ul className="flex flex-col gap-2 text-sm list-disc pl-4 marker:text-accent">
              {version.rationale.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </section>
  );
}
