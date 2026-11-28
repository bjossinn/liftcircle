import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronLeft, ChevronRight, Info, Pencil, Star, Trash2 } from 'lucide-react';
import type { CustomExercise, Exercise } from '@/domain/types';
import { Badge, Button, Card, ConfirmDialog, EmptyState, IconButton, Page, SectionTitle, Spinner } from '@/components/ui';
import { useToast } from '@/components/toast';
import { ExerciseGlyphTile } from '@/components/ExerciseGlyph';
import { exerciseGlyphKey } from '@/data/exerciseGlyphs';
import { ExerciseIllustration } from '@/components/ExerciseVisual';
import { ExerciseRowContent, exerciseRowClass } from '@/components/ExercisePicker';
import {
  CATEGORY_LABELS, DIFFICULTY_LABELS, EQUIPMENT_LABELS, LIMITATION_LABELS, LOAD_LABELS, loadConventionNote, MUSCLE_LABELS,
  PATTERN_LABELS, searchExercises, TRACKING_LABELS,
} from '@/data/exerciseMeta';
import { EXERCISES } from '@/data/exercises';
import { bundledExercise, useExercises } from '@/data/catalog';
import { exerciseAliases, exerciseDisplayName, exerciseExecution, exerciseMistakes, exerciseSetup } from '@/data/catalogText';
import { listText, useT } from '@/i18n';
import { localizeGeneratedText } from '@/domain/program/localize';
import { deleteRecord } from '@/db/repo';
import { useApp } from '@/state/app';
import { formatDate } from '@/lib/dates';
import { CustomExerciseForm } from './CustomExerciseForm';
import { useSubstitutionConstraints } from '@/features/train/hooks';
import { fitsConstraints, hasConstraints } from '@/domain/substitution';
import { formatLoggedSet, useExerciseHistory, useExerciseUsageCount, useFavoriteExercises } from './useExerciseData';

export default function ExerciseDetailPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { db } = useApp();
  const { t } = useT();
  const bundled = bundledExercise(id);
  // null = looked up and not found; undefined = still loading.
  const custom = useLiveQuery(async () => (bundled ? null : ((await db.customExercises.get(id)) ?? null)), [db, id, bundled]);

  const back = (
    <IconButton label={t('common.back')} onClick={() => nav(-1)} iconSize="lg">
      <ChevronLeft />
    </IconButton>
  );

  if (!bundled && custom === undefined)
    return (
      <Page back={back} title={t('workout.exerciseFallback')}>
        <Spinner label={t('exercise.detail.loading_exercise')} />
      </Page>
    );

  const ex: Exercise | null = bundled ?? (custom && !custom.deletedAt ? custom : null);
  if (!ex)
    return (
      <Page back={back} title={t('workout.exerciseFallback')}>
        <EmptyState
          title={t('exercise.detail.exercise_not_found')}
          body={t('exercise.detail.it_may_have_been_deleted_or')}
          action={
            <Button variant="primary" onClick={() => nav('/train/exercises', { replace: true })}>
              {t('exercise.detail.browse_exercises')}
            </Button>
          }
        />
      </Page>
    );

  return <Detail key={ex.id} ex={ex} back={back} />;
}

function Detail({ ex, back }: { ex: Exercise; back: ReactNode }) {
  const nav = useNavigate();
  const toast = useToast();
  const { t, tp, language } = useT();
  const { db, account, updateAccount } = useApp();
  const { byId } = useExercises();
  const fav = useFavoriteExercises();
  const history = useExerciseHistory(ex.id);
  const isCustom = !!ex.custom;
  const usage = useExerciseUsageCount(isCustom ? ex.id : undefined);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showAllSubs, setShowAllSubs] = useState(false);
  const constraints = useSubstitutionConstraints();
  const unit = account.settings.units.weight;
  const distanceUnit = account.settings.units.distance;
  const isFav = fav.isFav(ex.id);
  const note = loadConventionNote(ex);

  const allSubs = ex.substitutions.map((id) => byId.get(id)).filter((e): e is Exercise => !!e);
  // Default: only alternatives that fit the user's equipment, exclusions and limitations; "Show all" overrides.
  const fittingSubs = hasConstraints(constraints) ? allSubs.filter((e) => fitsConstraints(e, constraints)) : allSubs;
  const subs = showAllSubs || !fittingSubs.length ? allSubs : fittingSubs;
  const hiddenSubs = allSubs.length - fittingSubs.length;
  const similar = subs.length ? [] : searchExercises(EXERCISES, '', { pattern: ex.pattern }).filter((e) => e.id !== ex.id).slice(0, 4);

  async function toggleFav() {
    try {
      await fav.toggle(ex.id);
      toast.show(isFav ? t('exercise.detail.removed_from_favourites') : t('exercise.detail.added_to_favourites'), { tone: 'success' });
    } catch (e) {
      toast.show(e instanceof Error ? e.message : t('exercise.detail.could_not_update_favourites'), { tone: 'error' });
    }
  }

  async function remove() {
    setDeleting(true);
    try {
      await deleteRecord('custom_exercises', ex.id, db);
      if (isFav)
        await updateAccount((a) => ({ ...a, favorites: { ...a.favorites, recipes: a.favorites?.recipes ?? [], exercises: (a.favorites?.exercises ?? []).filter((x) => x !== ex.id) } }));
      toast.show(t('exercise.detail.exercise_deleted'), { tone: 'success' });
      nav('/train/exercises', { replace: true });
    } catch (e) {
      toast.show(e instanceof Error ? e.message : t('exercise.detail.could_not_delete_the_exercise'), { tone: 'error' });
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  const loadLabel =
    ex.load === 'per_hand'
      ? t(ex.implements === 2 ? 'exercise.detail.load_per_hand_pair' : 'exercise.detail.load_per_hand_single', { load: LOAD_LABELS.per_hand })
      : LOAD_LABELS[ex.load];
  const name = exerciseDisplayName(ex);
  const aliases = exerciseAliases(ex);
  const setup = exerciseSetup(ex);
  const execution = exerciseExecution(ex);
  const mistakes = exerciseMistakes(ex);
  const patternLabel = PATTERN_LABELS[ex.pattern];

  return (
    <Page
      back={back}
      actions={
        <>
          {isCustom && (
            <IconButton label={t('workout.custom.edit')} onClick={() => setEditing(true)}>
              <Pencil className="size-5" />
            </IconButton>
          )}
          <IconButton label={isFav ? t('exercise.detail.remove_from_favourites') : t('exercise.detail.add_to_favourites')} aria-pressed={isFav} onClick={toggleFav}>
            <Star className={isFav ? 'size-6 fill-current text-accent' : 'size-6'} />
          </IconButton>
        </>
      }
    >
      <Card className="p-4 flex items-start gap-4">
        <ExerciseGlyphTile glyph={exerciseGlyphKey(ex)} pattern={ex.pattern} size="lg" />
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold tracking-tight leading-tight">{name}</h1>
          {aliases.length > 0 && <p className="mt-1 text-sm text-muted">{t('exercise.detail.also_called', { names: listText(aliases, language) })}</p>}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge tone="accent">{PATTERN_LABELS[ex.pattern]}</Badge>
            <Badge>{CATEGORY_LABELS[ex.category]}</Badge>
            {isCustom && <Badge tone="info">{t('exercise.customBadge')}</Badge>}
            {ex.mainLift && <Badge>{t('exercise.detail.main_lift')}</Badge>}
          </div>
        </div>
      </Card>

      {/* Image + technique cues; renders nothing for custom exercises (the glyph above stays). */}
      <ExerciseIllustration ex={ex} className="mt-3 rounded-2xl bg-surface border border-line card-shadow p-4" />

      <Card className="mt-3 p-4">
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-sm">
          <Fact label={t('workout.custom.primaryMuscles')} value={ex.primaryMuscles.map((m) => MUSCLE_LABELS[m]).join(', ')} />
          {ex.secondaryMuscles.length > 0 && <Fact label={t('exercise.detail.secondary_muscles')} value={ex.secondaryMuscles.map((m) => MUSCLE_LABELS[m]).join(', ')} />}
          <Fact label={t('workout.custom.equipment')} value={ex.equipment.map((q) => EQUIPMENT_LABELS[q]).join(', ')} />
          {!isCustom && <Fact label={t('exercise.detail.difficulty')} value={DIFFICULTY_LABELS[ex.difficulty]} />}
          <Fact label={t('workout.custom.tracking')} value={TRACKING_LABELS[ex.tracking]} />
          {ex.load !== 'none' && <Fact label={t('exercise.detail.load')} value={loadLabel} />}
          {ex.unilateral && <Fact label={t('exercise.detail.sides')} value={t('exercise.detail.one_side_at_a_time')} />}
          {ex.stresses.length > 0 && <Fact label={t('exercise.detail.joint_areas_loaded')} value={ex.stresses.map((s) => LIMITATION_LABELS[s]).join(', ')} />}
        </dl>
      </Card>

      {note && (
        <div className="mt-3 flex gap-2.5 rounded-xl border border-accent/30 bg-accent-soft px-3.5 py-3 text-sm">
          <Info className="size-4 mt-0.5 shrink-0 text-accent" aria-hidden />
          <p>{note}</p>
        </div>
      )}

      {/* Library exercises show their (translated) cues under the illustration above; custom ones keep their own here. */}
      {(setup || execution || (isCustom && ex.cues.length > 0) || mistakes.length > 0) && (
        <>
          <SectionTitle>{isCustom ? t('workout.custom.notes') : t('workout.howTo')}</SectionTitle>
          <Card className="p-4 flex flex-col gap-4 text-[15px] leading-relaxed">
            {setup && <TextBlock title={isCustom ? undefined : t('exercise.detail.setup')} body={setup} />}
            {execution && <TextBlock title={t('exercise.detail.execution')} body={execution} />}
            {isCustom && ex.cues.length > 0 && <BulletBlock title={t('exercise.detail.cues')} items={ex.cues} />}
            {mistakes.length > 0 && <BulletBlock title={t('exercise.detail.common_mistakes')} items={mistakes} tone="warn" />}
          </Card>
        </>
      )}

      <SectionTitle>{t('exercise.detail.your_recent_sets')}</SectionTitle>
      <Card>
        {history === undefined ? (
          <Spinner label={t('exercise.detail.loading_history')} />
        ) : history.length === 0 ? (
          <p className="px-4 py-5 text-sm text-muted">{t('exercise.detail.no_completed_sets_yet_your_last')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {history.map((h) => (
              <li key={h.sessionId}>
                <Link to={`/train/history/${encodeURIComponent(h.sessionId)}`} className="flex items-start gap-3 px-4 py-3 min-h-14 hover:bg-surface-2 transition-colors">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[15px] font-medium">{formatDate(h.date)}</span>
                      <span className="text-xs text-muted truncate">{localizeGeneratedText(h.sessionName)}</span>
                    </div>
                    {h.sets.length ? (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {h.sets.map((s) => (
                          <span key={s.id} className="tabular rounded-lg bg-surface-2 px-2 py-0.5 text-sm">
                            {formatLoggedSet(s, ex, unit, distanceUnit)}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-1 text-sm text-muted">{t('exercise.detail.warm_up_sets_only')}</p>
                    )}
                    {h.warmups > 0 && h.sets.length > 0 && (
                      <p className="mt-1 text-xs text-faint">
                        {tp('exercise.detail.warmups', h.warmups)}
                      </p>
                    )}
                  </div>
                  <ChevronRight className="size-5 mt-0.5 shrink-0 text-muted" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {(subs.length > 0 || similar.length > 0) && (
        <>
          <SectionTitle>{subs.length ? t('exercise.detail.substitutions') : t('exercise.detail.similar_exercises')}</SectionTitle>
          <p className="px-1 -mt-1 mb-2 text-xs text-muted">
            {subs.length
              ? t('exercise.detail.swap_in_one_of_these_if')
              : t('exercise.detail.other_x_movements_from_the_library', { pattern: language === 'en' ? patternLabel.toLowerCase() : patternLabel })}
            {hiddenSubs > 0 && fittingSubs.length > 0 && (
              <>
                {' '}
                <button className="font-medium text-accent underline" aria-pressed={showAllSubs} onClick={() => setShowAllSubs((v) => !v)}>
                  {showAllSubs ? t('exercise.detail.only_ones_that_fit_your_setup') : t('exercise.detail.show_all_exercises_x_more', { count: hiddenSubs })}
                </button>
              </>
            )}
          </p>
          <ul className="rounded-2xl bg-surface border border-line divide-y divide-line overflow-hidden">
            {(subs.length ? subs : similar).map((s) => (
              <li key={s.id}>
                <Link to={`/train/exercises/${encodeURIComponent(s.id)}`} className={exerciseRowClass}>
                  <ExerciseRowContent ex={s} favorite={fav.isFav(s.id)} right={<ChevronRight className="size-5" aria-hidden />} />
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      {isCustom && (
        <div className="mt-6 flex gap-2">
          <Button className="flex-1" icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
            {t('common.edit')}
          </Button>
          <Button className="flex-1" variant="danger" icon={<Trash2 className="size-4" />} onClick={() => setConfirmDelete(true)}>
            {t('common.delete')}
          </Button>
        </div>
      )}

      {isCustom && (
        <>
          <CustomExerciseForm open={editing} onClose={() => setEditing(false)} initial={ex as CustomExercise} />
          <ConfirmDialog
            open={confirmDelete}
            title={t('exercise.detail.delete_this_exercise')}
            danger
            confirmLabel={t('common.delete')}
            busy={deleting}
            onCancel={() => setConfirmDelete(false)}
            onConfirm={remove}
            body={
              usage
                ? tp('exercise.detail.x_appears_in_x_workoutx_those', usage, { name })
                : t('exercise.detail.x_will_be_removed_from_your', { name })
            }
          />
        </>
      )}
    </Page>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 text-ink">{value}</dd>
    </div>
  );
}

function TextBlock({ title, body }: { title?: string; body: string }) {
  return (
    <div>
      {title && <h3 className="text-sm font-semibold text-muted mb-1">{title}</h3>}
      <p className="whitespace-pre-line">{body}</p>
    </div>
  );
}

function BulletBlock({ title, items, tone }: { title: string; items: string[]; tone?: 'warn' }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-muted mb-1">{title}</h3>
      <ul className="flex flex-col gap-1">
        {items.map((c) => (
          <li key={c} className="flex gap-2">
            <span className={tone === 'warn' ? 'mt-2.5 size-1.5 shrink-0 rounded-full bg-warn' : 'mt-2.5 size-1.5 shrink-0 rounded-full bg-ember'} aria-hidden />
            <span>{c}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
