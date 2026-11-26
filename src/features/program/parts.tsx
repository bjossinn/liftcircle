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
import { displayWeight } from '@/domain/units';
import { defaultPrescription, estimateSessionMinutes, WEEK_ORDER } from '@/domain/program/generator';
import { currentRationale, exerciseCue, exerciseNote, prescriptionText, restText, rirPlain, sessionCalibrationTip, sessionWarmupTip } from '@/domain/program/explain';
import { activityName, cardioNotesText, localizeGeneratedText, sessionDisplayName } from '@/domain/program/localize';
import { isBeginner } from '@/domain/progression';
import { weekdayShort } from '@/lib/dates';
import { EN, loadText, locale, t as translate, useT, type MessageKey, type Params } from '@/i18n';
import type { Exercise, Experience, Goal, ID, Prescription, ProgramVersion, SessionTemplate, WeightUnit } from '@/domain/types';

const KIND_KEYS: Record<SessionTemplate['kind'], MessageKey> = {
  lifting: 'program.kind.strength',
  cardio: 'program.kind.cardio',
  walk: 'program.kind.walk',
  mobility: 'program.kind.mobility',
  conditioning: 'program.kind.conditioning',
};
/** Session kind labels, read in the current language. */
export const KIND_LABEL: Record<SessionTemplate['kind'], string> = Object.defineProperties(
  {} as Record<SessionTemplate['kind'], string>,
  Object.fromEntries(Object.entries(KIND_KEYS).map(([k, key]) => [k, { enumerable: true, get: () => translate(key) }])),
);

const INTENSITY_KEYS: Record<NonNullable<SessionTemplate['cardio']>['intensity'], MessageKey> = {
  easy: 'program.easy',
  moderate: 'program.moderate',
  hard: 'program.hard',
};

/* ------------------------------------------------- stored text → display */
/** Stored plan text (session names, version reasons) is canonical English; it is localized only when shown. */
const enText = (key: MessageKey, params?: Params) => translate(key, params, 'en');

/** Full-string recognizer for an English template with {{placeholders}} (anchored; never a substring match). */
function matchTemplate(key: MessageKey, text: string): Record<string, string> | null {
  const names: string[] = [];
  const source = EN[key]
    .split(/(\{\{\w+\}\})/)
    .map((part) => {
      const m = /^\{\{(\w+)\}\}$/.exec(part);
      if (!m) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(m[1]);
      return '(.+)';
    })
    .join('');
  const m = new RegExp(`^${source}$`, 's').exec(text);
  if (!m) return null;
  return Object.fromEntries(names.map((n, i) => [n, m[i + 1]]));
}

/** Session name for display: manual "Session A" names and generated names are localized; custom names unchanged. */
export function displaySessionName(t: Pick<SessionTemplate, 'id' | 'name'>): string {
  if (t.id.startsWith('custom:')) {
    const m = matchTemplate('onboarding.manualSessionName', t.name);
    if (m && /^[A-Z]$/.test(m.letter)) return translate('onboarding.manualSessionName', { letter: m.letter });
  }
  return sessionDisplayName(t);
}

/** Plan text the onboarding/editor stores in English (manual-setup rationale/reason), else generated-text recognizer. */
export function planTextForDisplay(text: string): string {
  if (text === enText('onboarding.manualRationale')) return translate('onboarding.manualRationale');
  if (text === enText('onboarding.manualReason')) return translate('onboarding.manualReason');
  return localizeGeneratedText(text);
}

/** Edit reasons SessionCard stores on new versions (English), localized for display (e.g. in version history). */
const REASON_KEYS: MessageKey[] = ['program.reordered', 'program.removed', 'program.editedExercise', 'program.swapped', 'program.added', 'program.renamed', 'program.edited'];
export function versionReasonText(reason: string): string {
  for (const key of REASON_KEYS) {
    const params = matchTemplate(key, reason);
    if (params) return translate(key, params.sessionName ? { ...params, sessionName: sessionDisplayName({ name: params.sessionName }) } : params);
  }
  return planTextForDisplay(reason);
}

export function KindIcon({ kind, className = 'size-4' }: { kind: SessionTemplate['kind']; className?: string }) {
  if (kind === 'walk' || kind === 'cardio') return <Footprints className={className} aria-hidden />;
  if (kind === 'mobility') return <StretchHorizontal className={className} aria-hidden />;
  return <Dumbbell className={className} aria-hidden />;
}

/** Weekly schedule overview ordered from the user's week start. */
export function WeekStrip({ version, weekStart = 1, highlight }: { version: Pick<ProgramVersion, 'schedule' | 'templates'>; weekStart?: 0 | 1; highlight?: number }) {
  const { t: tr } = useT();
  const order = weekStart === 1 ? WEEK_ORDER : [0, 1, 2, 3, 4, 5, 6];
  return (
    <ol className="grid grid-cols-7 gap-1" aria-label={tr('program.schedule')}>
      {order.map((d) => {
        const slots = version.schedule.filter((s) => s.weekday === d);
        const names = slots.map((s) => version.templates.find((t) => t.id === s.templateId)).filter(Boolean) as SessionTemplate[];
        const hard = names.some((t) => t.kind === 'lifting' || t.kind === 'conditioning');
        return (
          <li
            key={d}
            className={`rounded-xl border px-1 py-2 text-center min-h-16 flex flex-col items-center gap-1 ${hard ? 'border-accent/40 bg-accent-soft' : names.length ? 'border-line bg-surface-2' : 'border-line'} ${highlight === d ? 'ring-2 ring-accent' : ''}`}
          >
            <span className="text-[11px] font-semibold text-muted">{weekdayShort(d)}</span>
            {names.length ? (
              names.map((t, i) => (
                <span key={i} className="text-[10px] leading-tight text-ink line-clamp-2">
                  {displaySessionName(t)}
                </span>
              ))
            ) : (
              <span className="text-[10px] text-faint">{tr('program.restDay')}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function rxSummary(rx: Prescription, ex: Exercise | undefined, unit: WeightUnit): string {
  const parts = [prescriptionText(rx)];
  if (rx.startLoadKg != null) parts.push(translate('program.startLoad', { weight: loadText(displayWeight(rx.startLoadKg, unit), unit) }));
  else if (rx.calibrate) parts.push(translate('program.calibrate'));
  if (ex?.unilateral && !rx.durationSec) parts.push(translate('program.perSide'));
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
  const { t: tr } = useT();
  const shownName = displaySessionName(t);
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
  const nameOf = (id: ID) => byId.get(id)?.name ?? tr('program.unknownExercise');
  /** Stored reasons use the stored (English canonical) names; see versionReasonText for display. */
  const storedNameOf = (id: ID) => byId.get(id)?.name ?? enText('program.unknownExercise');

  // Session-level tips replace the same sentence repeated on every exercise row.
  const anyCalibrate = t.exercises.some((rx) => rx.calibrate);
  const anyGenericWarmup = t.kind === 'lifting' && t.exercises.some((rx) => exerciseCue(rx).generic);

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= t.exercises.length) return;
    const list = [...t.exercises];
    [list[i], list[j]] = [list[j], list[i]];
    setExercises(list, enText('program.reordered', { sessionName: t.name }));
  };

  return (
    <Card as="article" className="overflow-hidden" aria-label={shownName}>
      <div className="flex items-start gap-3 px-4 pt-3 pb-2">
        <div className="size-9 shrink-0 rounded-xl bg-surface-2 flex items-center justify-center text-accent mt-0.5">
          <KindIcon kind={t.kind} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold leading-tight">{shownName}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <Badge tone={t.kind === 'lifting' ? 'accent' : 'neutral'}>{KIND_LABEL[t.kind]}</Badge>
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3.5" aria-hidden /> {tr('program.estimatedTime', { minutes: t.estimatedMinutes })}
            </span>
            {days && days.length > 0 && (
              <span className="inline-flex items-center gap-1">
                <CalendarDays className="size-3.5" aria-hidden />
                {[...days].sort((a, b) => WEEK_ORDER.indexOf(a) - WEEK_ORDER.indexOf(b)).map((d) => weekdayShort(d)).join(', ')}
              </span>
            )}
          </div>
        </div>
        <IconButton label={open ? tr('program.collapse', { sessionName: shownName }) : tr('program.expand', { sessionName: shownName })} onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? <ChevronUp className="size-5" /> : <ChevronDown className="size-5" />}
        </IconButton>
      </div>

      {open && (
        <div className="px-4 pb-3">
          {t.cardio && (
            <div className="rounded-xl bg-surface-2 px-3 py-2.5 mb-2 text-sm">
              <div className="font-medium">
                {tr('program.cardioLine', {
                  activity: activityName(t.cardio.activity),
                  minutes: t.cardio.minutes,
                  intensity: tr(INTENSITY_KEYS[t.cardio.intensity]).toLocaleLowerCase(locale()),
                })}
              </div>
              {t.cardio.notes && <p className="text-muted text-xs mt-1">{cardioNotesText(t.cardio)}</p>}
              {editable && (
                <Button size="sm" variant="ghost" className="mt-1 -ml-2" icon={<Pencil className="size-4" />} onClick={() => setEditCardio(true)}>
                  {tr('program.edit')}
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
                          {rx.priority === 1 && <Badge tone="accent">{tr('program.main')}</Badge>}
                          {rx.priority === 3 && <Badge>{tr('program.accessory')}</Badge>}
                        </div>
                        <p className="text-xs text-muted mt-0.5 tabular">{rxSummary(rx, ex, unit)}</p>
                        {cue && <p className="text-xs text-faint mt-1">{cue}</p>}
                        {note && <p className="text-xs text-muted mt-1">{note}</p>}
                      </div>
                    </div>
                    {editable && (
                      <div className="flex flex-wrap gap-1 mt-1.5 pl-7">
                        <Button size="sm" variant="ghost" icon={<Repeat className="size-4" />} onClick={() => setSwapFor(rx)} aria-label={tr('program.swapExercise', { exercise: nameOf(rx.exerciseId) })}>
                          {tr('program.swap')}
                        </Button>
                        <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} onClick={() => setEditRx(rx)} aria-label={tr('program.editPrescription', { exercise: nameOf(rx.exerciseId) })}>
                          {tr('program.edit')}
                        </Button>
                        <IconButton size="sm" label={tr('program.moveUp', { exercise: nameOf(rx.exerciseId) })} disabled={i === 0} onClick={() => move(i, -1)}>
                          <ArrowUp className="size-4" />
                        </IconButton>
                        <IconButton size="sm" label={tr('program.moveDown', { exercise: nameOf(rx.exerciseId) })} disabled={i === t.exercises.length - 1} onClick={() => move(i, 1)}>
                          <ArrowDown className="size-4" />
                        </IconButton>
                        <IconButton
                          size="sm"
                          label={tr('program.remove', { exercise: nameOf(rx.exerciseId) })}
                          onClick={() => setExercises(t.exercises.filter((x) => x.id !== rx.id), enText('program.removed', { exercise: storedNameOf(rx.exerciseId) }))}
                        >
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
              {anyGenericWarmup && <li>{sessionWarmupTip()}</li>}
              {anyCalibrate && <li>{sessionCalibrationTip()}</li>}
            </ul>
          )}
          {t.kind === 'lifting' && t.exercises.length === 0 && <p className="text-sm text-muted py-3">{tr('program.empty')}</p>}

          {t.trimmedExerciseIds && t.trimmedExerciseIds.length > 0 && (
            <p className="text-xs text-muted mt-2">
              {tr('program.trimmed', { exercises: t.trimmedExerciseIds.map(nameOf).join(', ') })}
              {editable && ` ${tr('program.trimmedHelp')}`}
            </p>
          )}

          {editable && (
            <div className="flex flex-wrap gap-2 mt-3">
              {(t.kind === 'lifting' || t.exercises.length > 0) && (
                <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
                  {tr('program.addExercise')}
                </Button>
              )}
              <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} onClick={() => setRenaming(true)}>
                {tr('program.rename')}
              </Button>
              {props.onDaysChange && (
                <Button size="sm" variant="ghost" icon={<CalendarDays className="size-4" />} onClick={() => setEditDays(true)}>
                  {tr('program.days')}
                </Button>
              )}
              {props.onRegenerate && (
                <Button size="sm" variant="ghost" icon={<RefreshCw className="size-4" />} onClick={props.onRegenerate} aria-label={tr('program.shuffleSession', { sessionName: shownName })}>
                  {tr('program.shuffle')}
                </Button>
              )}
              {props.onDuplicate && (
                <Button size="sm" variant="ghost" icon={<Copy className="size-4" />} onClick={props.onDuplicate}>
                  {tr('program.saveLibrary')}
                </Button>
              )}
              {props.onDelete && (
                <Button size="sm" variant="ghost" className="text-danger" icon={<Trash2 className="size-4" />} onClick={() => setConfirmDelete(true)}>
                  {tr('program.delete')}
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
            enText('program.editedExercise', { exercise: storedNameOf(next.exerciseId), sessionName: t.name }),
          );
          setEditRx(null);
        }}
      />
      <ExercisePicker
        open={!!swapFor}
        onClose={() => setSwapFor(null)}
        title={swapFor ? tr('program.swapExercise', { exercise: nameOf(swapFor.exerciseId) }) : tr('program.swapTitle')}
        suggestIds={swapFor ? [...new Set([...swapFor.alternatives, ...(byId.get(swapFor.exerciseId)?.substitutions ?? [])])] : []}
        excludeIds={t.exercises.map((x) => x.exerciseId)}
        onlyIds={props.pickerOnlyIds}
        onlyNote={props.pickerOnlyNote}
        onPick={(ex) => {
          if (!swapFor) return;
          const old = storedNameOf(swapFor.exerciseId);
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
            enText('program.swapped', { from: old, to: ex.name }),
          );
          setSwapFor(null);
        }}
      />
      <ExercisePicker
        open={adding}
        onClose={() => setAdding(false)}
        title={tr('program.addTo', { sessionName: shownName })}
        excludeIds={t.exercises.map((x) => x.exerciseId)}
        onlyIds={props.pickerOnlyIds}
        onlyNote={props.pickerOnlyNote}
        onPick={(ex) => {
          const slotId = `${t.id}:x${Date.now().toString(36)}`;
          setExercises([...t.exercises, defaultPrescription(ex, slotId, props.experience, props.goal, t.exercises.length === 0 ? 1 : 2)], enText('program.added', { exercise: ex.name, sessionName: t.name }));
          setAdding(false);
        }}
      />
      <RenameSheet
        open={renaming}
        value={t.name}
        title={tr('program.renameTitle')}
        onClose={() => setRenaming(false)}
        onSave={(name) => {
          commit({ ...t, name }, enText('program.renamed', { from: t.name, to: name }));
          setRenaming(false);
        }}
      />
      {props.onDaysChange && (
        <DaysSheet open={editDays} days={days ?? []} title={tr('program.daysFor', { sessionName: shownName })} onClose={() => setEditDays(false)} onSave={(d) => { props.onDaysChange!(d); setEditDays(false); }} />
      )}
      {t.cardio && (
        <CardioSheet open={editCardio} template={t} onClose={() => setEditCardio(false)} onSave={(cardio) => { commit({ ...t, cardio }, enText('program.edited', { sessionName: t.name })); setEditCardio(false); }} />
      )}
      {props.onDelete && (
        <ConfirmDialog
          open={confirmDelete}
          title={tr('program.deleteTitle', { sessionName: shownName })}
          body={tr('program.deleteBody')}
          confirmLabel={tr('program.deleteSession')}
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
  const { t: tr } = useT();
  return (
    <Sheet open={open} onClose={onClose} title={ex ? ex.name : tr('program.editExercise')}>
      {rx && <PrescriptionForm key={rx.id + rx.exerciseId} rx={rx} ex={ex} onCancel={onClose} onSave={onSave} />}
    </Sheet>
  );
}

function PrescriptionForm({ rx, ex, onSave, onCancel }: { rx: Prescription; ex?: Exercise; onSave: (rx: Prescription) => void; onCancel: () => void }) {
  const { t: tr } = useT();
  const [d, setD] = useState<Prescription>(rx);
  const timed = d.durationSec != null || ex?.tracking === 'duration';
  const errors: string[] = [];
  if (d.sets < 1 || d.sets > 10) errors.push(tr('program.validation.sets'));
  if (!timed && (d.repMin < 1 || d.repMax < d.repMin || d.repMax > 50)) errors.push(tr('program.validation.reps'));
  if (timed && (!d.durationSec || d.durationSec < 5 || d.durationSec > 3600)) errors.push(tr('program.validation.seconds'));
  if (d.restSec < 0 || d.restSec > 600) errors.push(tr('program.validation.rest'));
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!errors.length) onSave(d);
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <NumberInput label={tr('program.workingSets')} decimals={false} min={1} max={10} value={d.sets} onChange={(v) => setD({ ...d, sets: v ?? 1 })} />
        <NumberInput label={tr('program.restSeconds')} decimals={false} min={0} max={600} value={d.restSec} onChange={(v) => setD({ ...d, restSec: v ?? 0 })} hint={restText(d.restSec)} />
        {timed ? (
          <NumberInput label={tr('program.secondsPerSet')} decimals={false} min={5} max={3600} value={d.durationSec ?? 30} onChange={(v) => setD({ ...d, durationSec: v ?? 30 })} />
        ) : (
          <>
            <NumberInput label={tr('program.repsMin')} decimals={false} min={1} max={50} value={d.repMin} onChange={(v) => setD({ ...d, repMin: v ?? 1 })} />
            <NumberInput label={tr('program.repsMax')} decimals={false} min={1} max={50} value={d.repMax} onChange={(v) => setD({ ...d, repMax: v ?? d.repMin })} />
          </>
        )}
        <NumberInput label={tr('program.targetRir')} decimals={false} min={0} max={5} value={d.targetRir} onChange={(v) => setD({ ...d, targetRir: v ?? 2 })} />
      </div>
      <p className="text-xs text-muted">{rirPlain()}</p>
      <div>
        <span className="text-sm font-medium block mb-1.5">{tr('program.role')}</span>
        <Segmented
          label={tr('program.priority')}
          value={d.priority}
          onChange={(v) => setD({ ...d, priority: v })}
          options={[
            { value: 1, label: tr('program.main') },
            { value: 2, label: tr('program.secondary') },
            { value: 3, label: tr('program.accessory') },
          ]}
        />
        <p className="text-xs text-muted mt-1">{tr('program.accessoryHelp')}</p>
      </div>
      <Textarea label={tr('program.notesOptional')} value={d.notes ?? ''} maxLength={300} onChange={(e) => setD({ ...d, notes: e.target.value || undefined })} />
      {errors.length > 0 && (
        <ul className="text-xs text-danger" role="alert">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          {tr('program.cancel')}
        </Button>
        <Button type="submit" variant="primary" disabled={errors.length > 0}>
          {tr('program.save')}
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
  const { t: tr } = useT();
  const [v, setV] = useState(value);
  const trimmed = v.trim();
  const error = !trimmed ? tr('program.validation.nameRequired') : trimmed.length > 60 ? tr('program.validation.nameLength') : null;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!error) onSave(trimmed);
      }}
    >
      <Input label={tr('program.name')} value={v} autoFocus maxLength={80} onChange={(e) => setV(e.target.value)} error={v !== value ? error : null} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          {tr('program.cancel')}
        </Button>
        <Button type="submit" variant="primary" disabled={!!error}>
          {tr('program.save')}
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
  const { t: tr } = useT();
  const [d, setD] = useState<number[]>(days);
  return (
    <div className="flex flex-col gap-4">
      <ChipGroup label={tr('program.weekdays')} values={d} onChange={setD} options={WEEK_ORDER.map((w) => ({ value: w, label: weekdayShort(w) }))} />
      <p className="text-xs text-muted">{tr('program.weekdaysHelp')}</p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          {tr('program.cancel')}
        </Button>
        <Button variant="primary" onClick={() => onSave(d)}>
          {tr('program.save')}
        </Button>
      </div>
    </div>
  );
}

function CardioSheet({ open, template, onClose, onSave }: { open: boolean; template: SessionTemplate; onClose: () => void; onSave: (c: NonNullable<SessionTemplate['cardio']>) => void }) {
  const { t: tr } = useT();
  return (
    <Sheet open={open} onClose={onClose} title={tr('program.editSession', { sessionName: displaySessionName(template) })}>
      {open && template.cardio && <CardioForm cardio={template.cardio} onSave={onSave} onCancel={onClose} />}
    </Sheet>
  );
}
function CardioForm({ cardio, onSave, onCancel }: { cardio: NonNullable<SessionTemplate['cardio']>; onSave: (c: NonNullable<SessionTemplate['cardio']>) => void; onCancel: () => void }) {
  const { t: tr } = useT();
  const [c, setC] = useState(cardio);
  const bad = !c.minutes || c.minutes < 5 || c.minutes > 600;
  return (
    <div className="flex flex-col gap-4">
      <NumberInput
        label={tr('program.minutes')}
        decimals={false}
        min={5}
        max={600}
        value={c.minutes}
        onChange={(v) => setC({ ...c, minutes: v ?? 5 })}
        error={bad ? tr('program.validation.minutes') : null}
      />
      <div>
        <span className="text-sm font-medium block mb-1.5">{tr('program.effort')}</span>
        <Segmented
          label={tr('program.effort')}
          value={c.intensity}
          onChange={(v) => setC({ ...c, intensity: v })}
          options={[
            { value: 'easy', label: tr(INTENSITY_KEYS.easy) },
            { value: 'moderate', label: tr(INTENSITY_KEYS.moderate) },
            { value: 'hard', label: tr(INTENSITY_KEYS.hard) },
          ]}
        />
      </div>
      <Textarea label={tr('program.notes')} value={c.notes} maxLength={300} onChange={(e) => setC({ ...c, notes: e.target.value })} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          {tr('program.cancel')}
        </Button>
        <Button variant="primary" disabled={bad} onClick={() => onSave(c)}>
          {tr('program.save')}
        </Button>
      </div>
    </div>
  );
}

/** One-line reading guide for prescriptions, shown once above the session list. */
export function PlanLegend() {
  const { t: tr } = useT();
  return <p className="text-xs text-muted px-1 -mt-1 mb-2">{tr('program.legend')}</p>;
}

/**
 * “Why this plan?” — rationale and warnings, collapsible. When collapsed, the header still says how many
 * trade-offs/safety notes there are, so warnings are never hidden without a visible signal.
 */
export function WhyItFits({ version, defaultOpen = false, experience }: { version: Pick<ProgramVersion, 'rationale' | 'warnings'>; defaultOpen?: boolean; experience?: Experience }) {
  const { t: tr, tp } = useT();
  const [open, setOpen] = useState(defaultOpen);
  const n = version.warnings.length;
  return (
    <section aria-labelledby="why-title" className="mt-4">
      <button type="button" className="flex w-full items-center justify-between gap-2 min-h-11 px-1 text-left" aria-expanded={open} aria-controls="why-body" onClick={() => setOpen(!open)}>
        <span className="flex flex-wrap items-center gap-2">
          <h2 id="why-title" className="text-[13px] font-semibold uppercase tracking-wide text-muted">
            {tr('program.why')}
          </h2>
          {n > 0 && (
            <Badge tone="warn">{tp('program.notesCount', n)}</Badge>
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
                  {planTextForDisplay(w)}
                </div>
              ))}
            </div>
          )}
          <Card className="px-4 py-3">
            <ul className="flex flex-col gap-2 text-sm list-disc pl-4 marker:text-accent">
              {currentRationale(version.rationale, isBeginner(experience)).map(planTextForDisplay).map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </section>
  );
}
