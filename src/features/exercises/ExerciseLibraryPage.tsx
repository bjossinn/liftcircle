import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ChevronLeft, ChevronRight, Clock, Dumbbell, Plus, Search, Star } from 'lucide-react';
import type { Equipment, Exercise, MovementPattern, MuscleGroup } from '@/domain/types';
import { Button, EmptyState, IconButton, Input, Page, Segmented, Spinner } from '@/components/ui';
import { ExerciseFilterBar, ExerciseRowContent, exerciseRowClass, hasFilters, type ExerciseFilterValue } from '@/components/ExercisePicker';
import { EQUIPMENT_LABELS, MUSCLE_LABELS, PATTERN_LABELS, searchExercises } from '@/data/exerciseMeta';
import { useExercises } from '@/data/catalog';
import { useT } from '@/i18n';
import { useFavoriteExercises, useRecentExerciseIds } from './useExerciseData';
import { CustomExerciseForm } from './CustomExerciseForm';

type Tab = 'all' | 'favorites' | 'recent' | 'custom';
const TABS: Tab[] = ['all', 'favorites', 'recent', 'custom'];

function pickParam<T extends string>(v: string | null, allowed: Record<T, unknown>): T | undefined {
  return v && v in allowed ? (v as T) : undefined;
}

export default function ExerciseLibraryPage() {
  const nav = useNavigate();
  const { t, tp } = useT();
  const [params, setParams] = useSearchParams();
  const { list, byId } = useExercises();
  const fav = useFavoriteExercises();
  const recentIds = useRecentExerciseIds(20);
  const [creating, setCreating] = useState(false);

  // Search, tab and filters live in the URL so returning from a detail page restores the view.
  const tab: Tab = (TABS as string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'all';
  const query = params.get('q') ?? '';
  const filters: ExerciseFilterValue = useMemo(
    () => ({
      muscle: pickParam<MuscleGroup>(params.get('muscle'), MUSCLE_LABELS),
      equipment: pickParam<Equipment>(params.get('equipment'), EQUIPMENT_LABELS),
      pattern: pickParam<MovementPattern>(params.get('pattern'), PATTERN_LABELS),
    }),
    [params],
  );

  const update = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  const source: Exercise[] | undefined = useMemo(() => {
    switch (tab) {
      case 'favorites':
        return fav.ids.map((id) => byId.get(id)).filter((e): e is Exercise => !!e);
      case 'recent':
        return recentIds?.map((id) => byId.get(id)).filter((e): e is Exercise => !!e);
      case 'custom':
        return list.filter((e) => e.custom);
      default:
        return list;
    }
  }, [tab, fav.ids, recentIds, byId, list]);

  const searching = query.trim() !== '' || hasFilters(filters);
  const results = useMemo(() => {
    if (!source) return undefined;
    // Recent keeps its recency order unless the user is searching.
    if (tab === 'recent' && !searching) return source;
    return searchExercises(source, query, filters);
  }, [source, query, filters, tab, searching]);

  return (
    <Page
      title={t('summary.exercises')}
      back={
        <IconButton label={t('common.back')} onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
      actions={
        <IconButton label={t('workout.custom.new')} onClick={() => setCreating(true)}>
          <Plus className="size-6" />
        </IconButton>
      }
    >
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted" aria-hidden />
        <Input
          type="search"
          aria-label={t('workout.picker.search')}
          placeholder={t('workout.picker.searchHint')}
          value={query}
          onChange={(e) => update({ q: e.target.value || undefined })}
          enterKeyHint="search"
          autoComplete="off"
          className="pl-9"
        />
      </div>
      <ExerciseFilterBar
        className="mt-2"
        value={filters}
        onChange={(f) => update({ muscle: f.muscle, equipment: f.equipment, pattern: f.pattern })}
      />

      <Segmented
        className="mt-3"
        label={t('exercise.library.exercise_list')}
        value={tab}
        onChange={(v) => update({ tab: v === 'all' ? undefined : v })}
        options={[
          { value: 'all', label: t('common.all') },
          { value: 'favorites', label: t('workout.picker.favourites') },
          { value: 'recent', label: t('foodLog.tab.recent') },
          { value: 'custom', label: t('exercise.library.tab_custom') },
        ]}
      />

      <div className="mt-3" aria-live="polite">
        {results === undefined ? (
          <Spinner label={t('exercise.library.loading_exercises')} />
        ) : results.length === 0 ? (
          <LibraryEmpty tab={tab} searching={searching} onCreate={() => setCreating(true)} onClear={() => update({ q: undefined, muscle: undefined, equipment: undefined, pattern: undefined })} />
        ) : (
          <>
            <p className="px-1 pb-2 text-xs text-muted">
              {tp('exercise.library.count', results.length)}
            </p>
            <ul className="rounded-2xl bg-surface border border-line divide-y divide-line overflow-hidden">
              {results.map((ex) => (
                <li key={ex.id}>
                  <Link to={`/train/exercises/${encodeURIComponent(ex.id)}`} className={exerciseRowClass}>
                    <ExerciseRowContent ex={ex} favorite={fav.isFav(ex.id)} right={<ChevronRight className="size-5" aria-hidden />} />
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {tab !== 'custom' && (
        <div className="mt-4">
          <Button block variant="outline" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
            {t('workout.custom.new')}
          </Button>
        </div>
      )}

      <CustomExerciseForm
        open={creating}
        onClose={() => setCreating(false)}
        defaultName={tab === 'custom' || searching ? query.trim() || undefined : undefined}
        onSaved={(ex) => nav(`/train/exercises/${encodeURIComponent(ex.id)}`)}
      />
    </Page>
  );
}

function LibraryEmpty({ tab, searching, onCreate, onClear }: { tab: Tab; searching: boolean; onCreate: () => void; onClear: () => void }) {
  const { t } = useT();
  if (searching)
    return (
      <EmptyState
        icon={<Search className="size-5" />}
        title={t('workout.picker.noMatches')}
        body={t('exercise.library.try_another_word_or_clear_the')}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={onClear}>{t('exercise.library.clear_search')}</Button>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={onCreate}>
              {t('workout.custom.create')}
            </Button>
          </div>
        }
      />
    );
  if (tab === 'favorites')
    return <EmptyState icon={<Star className="size-5" />} title={t('exercise.library.no_favourites_yet')} body={t('exercise.library.open_an_exercise_and_tap_the')} />;
  if (tab === 'recent')
    return <EmptyState icon={<Clock className="size-5" />} title={t('exercise.library.nothing_logged_yet')} body={t('exercise.library.exercises_from_your_finished_workouts_will')} />;
  if (tab === 'custom')
    return (
      <EmptyState
        icon={<Dumbbell className="size-5" />}
        title={t('exercise.library.no_custom_exercises')}
        body={t('exercise.library.add_a_movement_that_isnt_in')}
        action={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={onCreate}>
            {t('workout.custom.new')}
          </Button>
        }
      />
    );
  return <EmptyState title={t('exercise.library.no_exercises')} />;
}
