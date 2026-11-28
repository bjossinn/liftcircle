import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ChevronLeft, ChevronRight, Clock, Dumbbell, Plus, Search, Star } from 'lucide-react';
import type { Equipment, Exercise, MovementPattern, MuscleGroup } from '@/domain/types';
import { Button, EmptyState, IconButton, Input, Page, Segmented, Spinner } from '@/components/ui';
import { ExerciseFilterBar, ExerciseRowContent, exerciseRowClass, hasFilters, type ExerciseFilterValue } from '@/components/ExercisePicker';
import { EQUIPMENT_LABELS, MUSCLE_LABELS, PATTERN_LABELS, searchExercises } from '@/data/exerciseMeta';
import { useExercises } from '@/data/catalog';
import { useFavoriteExercises, useRecentExerciseIds } from './useExerciseData';
import { CustomExerciseForm } from './CustomExerciseForm';

type Tab = 'all' | 'favorites' | 'recent' | 'custom';
const TABS: Tab[] = ['all', 'favorites', 'recent', 'custom'];

function pickParam<T extends string>(v: string | null, allowed: Record<T, unknown>): T | undefined {
  return v && v in allowed ? (v as T) : undefined;
}

export default function ExerciseLibraryPage() {
  const nav = useNavigate();
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
      title="Exercises"
      back={
        <IconButton label="Back" onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
      actions={
        <IconButton label="New custom exercise" onClick={() => setCreating(true)}>
          <Plus className="size-6" />
        </IconButton>
      }
    >
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted" aria-hidden />
        <Input
          type="search"
          aria-label="Search exercises"
          placeholder="Search name, muscle or equipment"
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
        label="Exercise list"
        value={tab}
        onChange={(t) => update({ tab: t === 'all' ? undefined : t })}
        options={[
          { value: 'all', label: 'All' },
          { value: 'favorites', label: 'Favourites' },
          { value: 'recent', label: 'Recent' },
          { value: 'custom', label: 'Custom' },
        ]}
      />

      <div className="mt-3" aria-live="polite">
        {results === undefined ? (
          <Spinner label="Loading exercises" />
        ) : results.length === 0 ? (
          <LibraryEmpty tab={tab} searching={searching} onCreate={() => setCreating(true)} onClear={() => update({ q: undefined, muscle: undefined, equipment: undefined, pattern: undefined })} />
        ) : (
          <>
            <p className="px-1 pb-2 text-xs text-muted">
              {results.length} exercise{results.length === 1 ? '' : 's'}
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
            New custom exercise
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
  if (searching)
    return (
      <EmptyState
        icon={<Search className="size-5" />}
        title="No matching exercises"
        body="Try another word or clear the filters. You can also add the exercise yourself."
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={onClear}>Clear search</Button>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={onCreate}>
              Create exercise
            </Button>
          </div>
        }
      />
    );
  if (tab === 'favorites')
    return <EmptyState icon={<Star className="size-5" />} title="No favourites yet" body="Open an exercise and tap the star to keep it here for quick access." />;
  if (tab === 'recent')
    return <EmptyState icon={<Clock className="size-5" />} title="Nothing logged yet" body="Exercises from your finished workouts will show up here." />;
  if (tab === 'custom')
    return (
      <EmptyState
        icon={<Dumbbell className="size-5" />}
        title="No custom exercises"
        body="Add a movement that isn’t in the library. It works everywhere the built-in exercises do."
        action={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={onCreate}>
            New custom exercise
          </Button>
        }
      />
    );
  return <EmptyState title="No exercises" />;
}
