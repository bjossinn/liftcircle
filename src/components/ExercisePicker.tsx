import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, Plus, Search, Star } from 'lucide-react';
import type { Equipment, Exercise, ID, MovementPattern, MuscleGroup } from '@/domain/types';
import { Button, EmptyState, Input, Sheet, Spinner, cx } from '@/components/ui';
import { ExerciseGlyphTile } from '@/components/ExerciseGlyph';
import { EQUIPMENT_LABELS, exerciseSubtitle, MUSCLE_LABELS, PATTERN_LABELS, searchExercises } from '@/data/exerciseMeta';
import { useExercises } from '@/data/catalog';
import { useFavoriteExercises, useRecentExerciseIds } from '@/features/exercises/useExerciseData';
import { CustomExerciseForm } from '@/features/exercises/CustomExerciseForm';
import { useT } from '@/i18n';

/* ------------------------------------------------------------ filters */
export interface ExerciseFilterValue {
  muscle?: MuscleGroup;
  equipment?: Equipment;
  pattern?: MovementPattern;
}

export const hasFilters = (f: ExerciseFilterValue) => !!(f.muscle || f.equipment || f.pattern);

function ChipSelect<T extends string>({ label, anyLabel, value, options, onChange }: { label: string; anyLabel: string; value: T | undefined; options: Record<T, string>; onChange: (v: T | undefined) => void }) {
  const active = !!value;
  return (
    <label className="relative shrink-0">
      <span className="sr-only">{label}</span>
      <select
        value={value ?? ''}
        onChange={(e) => onChange((e.target.value || undefined) as T | undefined)}
        className={cx(
          'appearance-none min-h-11 rounded-full border pl-3.5 pr-8 text-sm transition-colors focus-visible:border-accent',
          active ? 'bg-accent-soft border-accent text-accent font-medium' : 'bg-surface-2 border-line text-ink',
        )}
      >
        <option value="">{anyLabel}</option>
        {(Object.keys(options) as T[]).map((k) => (
          <option key={k} value={k}>
            {options[k]}
          </option>
        ))}
      </select>
      <ChevronDown className={cx('pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 size-4', active ? 'text-accent' : 'text-muted')} aria-hidden />
    </label>
  );
}

/** Horizontally scrolling row of filter chips (muscle / equipment / movement). */
export function ExerciseFilterBar({ value, onChange, className }: { value: ExerciseFilterValue; onChange: (v: ExerciseFilterValue) => void; className?: string }) {
  const { t } = useT();
  return (
    <div role="group" aria-label={t('workout.picker.filters')} className={cx('flex items-center gap-2 overflow-x-auto -mx-1 px-1 py-1', className)}>
      <ChipSelect label={t('workout.picker.muscle')} anyLabel={t('workout.picker.anyMuscle')} value={value.muscle} options={MUSCLE_LABELS} onChange={(muscle) => onChange({ ...value, muscle })} />
      <ChipSelect label={t('workout.picker.equipment')} anyLabel={t('workout.picker.anyEquipment')} value={value.equipment} options={EQUIPMENT_LABELS} onChange={(equipment) => onChange({ ...value, equipment })} />
      <ChipSelect label={t('workout.picker.movement')} anyLabel={t('workout.picker.anyMovement')} value={value.pattern} options={PATTERN_LABELS} onChange={(pattern) => onChange({ ...value, pattern })} />
      {hasFilters(value) && (
        <Button size="sm" variant="ghost" className="shrink-0 min-h-11" onClick={() => onChange({})}>
          {/* i18n: no approved Icelandic copy */}
          Clear
        </Button>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- rows */
export function ExerciseRowContent({ ex, favorite, right }: { ex: Exercise; favorite?: boolean; right?: ReactNode }) {
  const { t, language } = useT();
  return (
    <>
      <ExerciseGlyphTile pattern={ex.pattern} />
      <span className="min-w-0 flex-1 text-left">
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 text-[15px] font-medium line-clamp-2 break-words">{ex.name}</span>
          {favorite && <Star className="size-3.5 shrink-0 fill-current text-accent" aria-label={t('workout.picker.favourite')} />}
          {/* i18n: no approved Icelandic copy */}
          {ex.custom && <span className="shrink-0 rounded-full bg-surface-3 px-1.5 text-[11px] text-muted">Custom</span>}
        </span>
        <span className="block text-xs text-muted truncate mt-0.5">{exerciseSubtitle(ex, language)}</span>
      </span>
      {right && <span className="shrink-0 text-muted">{right}</span>}
    </>
  );
}

export const exerciseRowClass = 'flex items-center gap-3 w-full px-3 py-2.5 min-h-16 hover:bg-surface-2 transition-colors focus-visible:bg-surface-2';

function PickRow({ ex, favorite, onPick }: { ex: Exercise; favorite: boolean; onPick: (ex: Exercise) => void }) {
  return (
    <li>
      <button type="button" className={exerciseRowClass} onClick={() => onPick(ex)}>
        <ExerciseRowContent ex={ex} favorite={favorite} />
      </button>
    </li>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = `picker-${title.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <section aria-labelledby={id} className="mt-4 first:mt-2">
      <h3 id={id} className="px-1 mb-1 text-[13px] font-semibold uppercase tracking-wide text-muted">
        {title}
      </h3>
      <ul className="rounded-2xl border border-line divide-y divide-line overflow-hidden">{children}</ul>
    </section>
  );
}

/* ------------------------------------------------------------- picker */
/**
 * Sheet for choosing an exercise: search, filters, suggested substitutions, favourites,
 * recently used and "create custom exercise". Picking calls `onPick` and then `onClose`.
 */
export function ExercisePicker(props: {
  open: boolean;
  onClose: () => void;
  onPick: (ex: Exercise) => void;
  title?: string;
  suggestIds?: ID[];
  excludeIds?: ID[];
  /**
   * Optional default restriction (e.g. the user's equipment, exclusions and movement constraints).
   * Lists show only matching exercises until the user taps "Show all exercises".
   */
  fits?: (ex: Exercise) => boolean;
  /** Short explanation of the restriction, e.g. "Showing exercises that fit your equipment and limits." */
  fitsNote?: string;
  /**
   * Hard restriction (no "Show all" override and no custom exercises), e.g. a coach building a client's
   * plan may only use the bundled catalog every client has.
   */
  onlyIds?: Set<ID>;
  onlyNote?: string;
}) {
  const { t } = useT();
  return (
    <Sheet open={props.open} onClose={props.onClose} title={props.title ?? t('workout.picker.choose')} wide>
      <PickerBody {...props} />
    </Sheet>
  );
}

function PickerBody({ onClose, onPick, suggestIds, excludeIds, fits, fitsNote, onlyIds, onlyNote }: { onClose: () => void; onPick: (ex: Exercise) => void; suggestIds?: ID[]; excludeIds?: ID[]; fits?: (ex: Exercise) => boolean; fitsNote?: string; onlyIds?: Set<ID>; onlyNote?: string }) {
  const { t, tp } = useT();
  const { list: fullList, byId } = useExercises();
  const list = useMemo(() => (onlyIds ? fullList.filter((e) => onlyIds.has(e.id)) : fullList), [fullList, onlyIds]);
  const allowCustom = !onlyIds;
  const fav = useFavoriteExercises();
  const recentIds = useRecentExerciseIds();
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<ExerciseFilterValue>({});
  const [creating, setCreating] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const restricted = !!fits && !showAll;

  const excluded = useMemo(() => new Set(excludeIds ?? []), [excludeIds]);
  const available = useMemo(() => list.filter((e) => !excluded.has(e.id) && (!restricted || e.custom || fits!(e))), [list, excluded, restricted, fits]);
  const hiddenCount = restricted ? list.filter((e) => !excluded.has(e.id)).length - available.length : 0;
  const resolve = (ids: ID[] | undefined) => (ids ?? []).map((id) => byId.get(id)).filter((e): e is Exercise => !!e && (!onlyIds || onlyIds.has(e.id)) && !excluded.has(e.id) && (!restricted || !!e.custom || fits!(e)));

  const searching = query.trim() !== '' || hasFilters(filters);
  const results = useMemo(() => (searching ? searchExercises(available, query, filters) : []), [searching, available, query, filters]);
  const all = useMemo(() => [...available].sort((a, b) => a.name.localeCompare(b.name)), [available]);

  const pick = (ex: Exercise) => {
    onPick(ex);
    onClose();
  };
  const row = (ex: Exercise, key: string) => <PickRow key={key} ex={ex} favorite={fav.isFav(ex.id)} onPick={pick} />;

  const suggested = resolve(suggestIds);
  const favourites = resolve(fav.ids).sort((a, b) => a.name.localeCompare(b.name));
  const recent = resolve(recentIds).slice(0, 8);

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 bg-surface pb-2 -mx-5 px-5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted" aria-hidden />
          <Input
            type="search"
            aria-label={t('workout.picker.search')}
            placeholder={t('workout.picker.searchHint')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            enterKeyHint="search"
            autoComplete="off"
            className="pl-9"
          />
        </div>
        <ExerciseFilterBar value={filters} onChange={setFilters} className="mt-2" />
        {fits && (
          <div className="mt-1 flex items-center gap-2 text-xs text-muted">
            <span className="flex-1">{showAll ? t('workout.picker.showingAll') : fitsNote ?? t('workout.picker.showingFits')}</span>
            {(showAll || hiddenCount > 0) && (
              <Button size="sm" variant="ghost" className="shrink-0" aria-pressed={showAll} onClick={() => setShowAll((v) => !v)}>
                {showAll ? t('workout.picker.onlyFits') : t('workout.picker.showAll')}
              </Button>
            )}
          </div>
        )}
      </div>

      {searching ? (
        results.length ? (
          <Section title={tp('workout.picker.results', results.length)}>{results.map((e) => row(e, e.id))}</Section>
        ) : (
          <EmptyState
            icon={<Search className="size-5" />}
            title={t('workout.picker.noMatches')}
            body={allowCustom ? t('workout.picker.noMatchesCreateHint') : t('workout.picker.noMatchesHint')}
            action={
              allowCustom ? (
                <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
                  {t('workout.picker.createNamed', { name: query.trim() || t('workout.picker.customFallback') })}
                </Button>
              ) : undefined
            }
          />
        )
      ) : (
        <>
          {suggested.length > 0 && <Section title={t('workout.picker.suggested')}>{suggested.map((e) => row(e, `s-${e.id}`))}</Section>}
          {favourites.length > 0 && <Section title={t('workout.picker.favourites')}>{favourites.map((e) => row(e, `f-${e.id}`))}</Section>}
          {recentIds === undefined ? <Spinner label={t('workout.picker.loadingRecent')} /> : recent.length > 0 && <Section title={t('workout.picker.recent')}>{recent.map((e) => row(e, `r-${e.id}`))}</Section>}
          <Section title={restricted ? t('workout.picker.exercisesFit') : t('workout.picker.all')}>{all.map((e) => row(e, `a-${e.id}`))}</Section>
        </>
      )}

      {allowCustom ? (
        <div className="mt-4">
          <Button block variant="outline" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
            {t('workout.picker.create')}
          </Button>
        </div>
      ) : (
        onlyNote && <p className="mt-4 text-xs text-muted">{onlyNote}</p>
      )}

      <CustomExerciseForm open={creating} onClose={() => setCreating(false)} defaultName={query.trim() || undefined} onSaved={(ex) => pick(ex)} />
    </div>
  );
}
