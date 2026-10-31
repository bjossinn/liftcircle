import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronLeft, ChevronRight, Info, Pencil, Star, Trash2 } from 'lucide-react';
import type { CustomExercise, Exercise } from '@/domain/types';
import { Badge, Button, Card, ConfirmDialog, EmptyState, IconButton, Page, SectionTitle, Spinner } from '@/components/ui';
import { useToast } from '@/components/toast';
import { ExerciseGlyphTile } from '@/components/ExerciseGlyph';
import { ExerciseRowContent, exerciseRowClass } from '@/components/ExercisePicker';
import {
  CATEGORY_LABELS, DIFFICULTY_LABELS, EQUIPMENT_LABELS, LIMITATION_LABELS, LOAD_LABELS, loadConventionNote, MUSCLE_LABELS,
  PATTERN_LABELS, searchExercises, TRACKING_LABELS,
} from '@/data/exerciseMeta';
import { EXERCISES } from '@/data/exercises';
import { bundledExercise, useExercises } from '@/data/catalog';
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
  const bundled = bundledExercise(id);
  // null = looked up and not found; undefined = still loading.
  const custom = useLiveQuery(async () => (bundled ? null : ((await db.customExercises.get(id)) ?? null)), [db, id, bundled]);

  const back = (
    <IconButton label="Back" onClick={() => nav(-1)}>
      <ChevronLeft className="size-6" />
    </IconButton>
  );

  if (!bundled && custom === undefined)
    return (
      <Page back={back} title="Exercise">
        <Spinner label="Loading exercise" />
      </Page>
    );

  const ex: Exercise | null = bundled ?? (custom && !custom.deletedAt ? custom : null);
  if (!ex)
    return (
      <Page back={back} title="Exercise">
        <EmptyState
          title="Exercise not found"
          body="It may have been deleted, or the link is out of date."
          action={
            <Button variant="primary" onClick={() => nav('/train/exercises', { replace: true })}>
              Browse exercises
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
      toast.show(isFav ? 'Removed from favourites' : 'Added to favourites', { tone: 'success' });
    } catch (e) {
      toast.show(e instanceof Error ? e.message : 'Could not update favourites', { tone: 'error' });
    }
  }

  async function remove() {
    setDeleting(true);
    try {
      await deleteRecord('custom_exercises', ex.id, db);
      if (isFav)
        await updateAccount((a) => ({ ...a, favorites: { ...a.favorites, recipes: a.favorites?.recipes ?? [], exercises: (a.favorites?.exercises ?? []).filter((x) => x !== ex.id) } }));
      toast.show('Exercise deleted', { tone: 'success' });
      nav('/train/exercises', { replace: true });
    } catch (e) {
      toast.show(e instanceof Error ? e.message : 'Could not delete the exercise', { tone: 'error' });
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  const loadLabel = ex.load === 'per_hand' ? `${LOAD_LABELS.per_hand}${ex.implements === 2 ? ' (pair)' : ' (single)'}` : LOAD_LABELS[ex.load];

  return (
    <Page
      back={back}
      actions={
        <>
          {isCustom && (
            <IconButton label="Edit exercise" onClick={() => setEditing(true)}>
              <Pencil className="size-5" />
            </IconButton>
          )}
          <IconButton label={isFav ? 'Remove from favourites' : 'Add to favourites'} aria-pressed={isFav} onClick={toggleFav}>
            <Star className={isFav ? 'size-6 fill-current text-accent' : 'size-6'} />
          </IconButton>
        </>
      }
    >
      <Card className="p-4 flex items-start gap-4">
        <ExerciseGlyphTile pattern={ex.pattern} size="lg" />
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold tracking-tight leading-tight">{ex.name}</h1>
          {ex.aliases.length > 0 && <p className="mt-1 text-sm text-muted">Also called {ex.aliases.join(', ')}</p>}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge tone="accent">{PATTERN_LABELS[ex.pattern]}</Badge>
            <Badge>{CATEGORY_LABELS[ex.category]}</Badge>
            {isCustom && <Badge tone="info">Custom</Badge>}
            {ex.mainLift && <Badge>Main lift</Badge>}
          </div>
        </div>
      </Card>

      <Card className="mt-3 p-4">
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-sm">
          <Fact label="Primary muscles" value={ex.primaryMuscles.map((m) => MUSCLE_LABELS[m]).join(', ')} />
          {ex.secondaryMuscles.length > 0 && <Fact label="Secondary muscles" value={ex.secondaryMuscles.map((m) => MUSCLE_LABELS[m]).join(', ')} />}
          <Fact label="Equipment" value={ex.equipment.map((q) => EQUIPMENT_LABELS[q]).join(', ')} />
          {!isCustom && <Fact label="Difficulty" value={DIFFICULTY_LABELS[ex.difficulty]} />}
          <Fact label="Tracking" value={TRACKING_LABELS[ex.tracking]} />
          {ex.load !== 'none' && <Fact label="Load" value={loadLabel} />}
          {ex.unilateral && <Fact label="Sides" value="One side at a time" />}
          {ex.stresses.length > 0 && <Fact label="Joint areas loaded" value={ex.stresses.map((s) => LIMITATION_LABELS[s]).join(', ')} />}
        </dl>
      </Card>

      {note && (
        <div className="mt-3 flex gap-2.5 rounded-xl border border-accent/30 bg-accent-soft px-3.5 py-3 text-sm">
          <Info className="size-4 mt-0.5 shrink-0 text-accent" aria-hidden />
          <p>{note}</p>
        </div>
      )}

      {(ex.setup || ex.execution || ex.cues.length > 0 || ex.mistakes.length > 0) && (
        <>
          <SectionTitle>{isCustom ? 'Notes' : 'How to do it'}</SectionTitle>
          <Card className="p-4 flex flex-col gap-4 text-[15px] leading-relaxed">
            {ex.setup && <TextBlock title={isCustom ? undefined : 'Setup'} body={ex.setup} />}
            {ex.execution && <TextBlock title="Execution" body={ex.execution} />}
            {ex.cues.length > 0 && <BulletBlock title="Cues" items={ex.cues} />}
            {ex.mistakes.length > 0 && <BulletBlock title="Common mistakes" items={ex.mistakes} tone="warn" />}
          </Card>
        </>
      )}

      <SectionTitle>Your recent sets</SectionTitle>
      <Card>
        {history === undefined ? (
          <Spinner label="Loading history" />
        ) : history.length === 0 ? (
          <p className="px-4 py-5 text-sm text-muted">No completed sets yet. Your last few sessions with this exercise will appear here.</p>
        ) : (
          <ul className="divide-y divide-line">
            {history.map((h) => (
              <li key={h.sessionId}>
                <Link to={`/train/history/${encodeURIComponent(h.sessionId)}`} className="flex items-start gap-3 px-4 py-3 min-h-14 hover:bg-surface-2 transition-colors">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[15px] font-medium">{formatDate(h.date)}</span>
                      <span className="text-xs text-muted truncate">{h.sessionName}</span>
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
                      <p className="mt-1 text-sm text-muted">Warm-up sets only</p>
                    )}
                    {h.warmups > 0 && h.sets.length > 0 && (
                      <p className="mt-1 text-xs text-faint">
                        + {h.warmups} warm-up set{h.warmups === 1 ? '' : 's'}
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
          <SectionTitle>{subs.length ? 'Substitutions' : 'Similar exercises'}</SectionTitle>
          <p className="px-1 -mt-1 mb-2 text-xs text-muted">
            {subs.length ? 'Swap in one of these if equipment is busy or this movement doesn’t feel right.' : `Other ${PATTERN_LABELS[ex.pattern].toLowerCase()} movements from the library.`}
            {hiddenSubs > 0 && fittingSubs.length > 0 && (
              <>
                {' '}
                <button className="font-medium text-accent underline" aria-pressed={showAllSubs} onClick={() => setShowAllSubs((v) => !v)}>
                  {showAllSubs ? 'Only ones that fit your setup' : `Show all exercises (${hiddenSubs} more)`}
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
            Edit
          </Button>
          <Button className="flex-1" variant="danger" icon={<Trash2 className="size-4" />} onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        </div>
      )}

      {isCustom && (
        <>
          <CustomExerciseForm open={editing} onClose={() => setEditing(false)} initial={ex as CustomExercise} />
          <ConfirmDialog
            open={confirmDelete}
            title="Delete this exercise?"
            danger
            confirmLabel="Delete"
            busy={deleting}
            onCancel={() => setConfirmDelete(false)}
            onConfirm={remove}
            body={
              usage
                ? `“${ex.name}” appears in ${usage} workout${usage === 1 ? '' : 's'}. Those logged sets are kept, but the exercise will no longer be available to pick.`
                : `“${ex.name}” will be removed from your library. This can’t be undone.`
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
