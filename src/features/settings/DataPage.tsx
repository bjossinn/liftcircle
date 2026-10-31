import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronLeft, Download, FileUp, HardDrive, RefreshCw } from 'lucide-react';
import { useApp } from '@/state/app';
import { Badge, Button, Card, ConfirmDialog, IconButton, Notice, Page, SectionTitle, Segmented, Toggle } from '@/components/ui';
import {
  SINGLETON_PARTS, activitiesCsv, applyImport, buildBackup, describePlan, downloadText, measurementsCsv, parseBackup, previewImport, stamp, workoutsCsv,
  type ExistingRule, type ImportPreview, type SingletonPart,
} from './backup';
import { MAX_BACKUP_BYTES } from './backupSchema';
import { ENTITY_LABELS } from '@/features/auth/guestImport';
import { useExercises } from '@/data/catalog';
import { requestPersistentStorage, deleteAccountDb, type SyncConflict, type SyncedEntity } from '@/db/db';
import { resolveConflict, retryFailed, syncNow, useSyncStatus } from '@/sync/engine';
import { DeleteAccountButton } from './account';
import { useToast } from '@/components/toast';

export default function DataPage() {
  const nav = useNavigate();
  const toast = useToast();
  const { db, auth } = useApp();
  const { byId } = useExercises();
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [estimate, setEstimate] = useState<{ usage?: number; quota?: number } | null>(null);
  const [wipe, setWipe] = useState(false);

  useEffect(() => {
    navigator.storage?.persisted?.().then(setPersisted).catch(() => setPersisted(null));
    navigator.storage?.estimate?.().then(setEstimate).catch(() => {});
  }, []);

  const exportJson = async () => {
    try {
      downloadText(`hard-earned-backup-${stamp()}.json`, JSON.stringify(await buildBackup(db), null, 2));
      toast.show('Backup downloaded', { tone: 'success' });
    } catch (e) {
      toast.show((e as Error).message, { tone: 'error' });
    }
  };
  const exportCsv = async (kind: 'workouts' | 'measurements' | 'activities') => {
    const text =
      kind === 'workouts' ? workoutsCsv(await db.sessions.toArray(), byId) : kind === 'measurements' ? measurementsCsv(await db.measurements.toArray()) : activitiesCsv(await db.activities.toArray());
    downloadText(`hard-earned-${kind}-${stamp()}.csv`, text, 'text/csv');
  };

  return (
    <Page
      title="Your data"
      back={
        <IconButton label="Back" onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
    >
      <SectionTitle>On this device</SectionTitle>
      <Card className="p-4 space-y-3 text-sm">
        <div className="flex items-center gap-2">
          <HardDrive className="size-4 text-muted" aria-hidden />
          <span className="flex-1">Protected from automatic clean-up</span>
          <Badge tone={persisted ? 'accent' : 'warn'}>{persisted ? 'Yes' : persisted === false ? 'Not yet' : 'Unknown'}</Badge>
        </div>
        {estimate?.usage != null && <p className="text-muted">Using about {(estimate.usage / 1024 / 1024).toFixed(1)} MB on this device.</p>}
        {!persisted && (
          <Button
            size="sm"
            onClick={async () => {
              const r = await requestPersistentStorage();
              setPersisted(!!r);
              toast.show(r ? 'Your browser will keep this data' : 'Your browser didn’t allow it. Installing the app to your home screen often helps.', { tone: r ? 'success' : 'warn' });
            }}
          >
            Ask the browser to keep my data
          </Button>
        )}
        <p className="text-muted">
          Records are stored in this browser. Clearing site data or uninstalling the browser removes them. {db.isGuest ? 'Create an account for automatic backup, or download backups regularly.' : 'Your account keeps a backup copy in the cloud.'}
        </p>
      </Card>

      {!db.isGuest && <SyncSection />}

      <SectionTitle>Back up & export</SectionTitle>
      <Card className="p-4 space-y-3">
        <Button variant="primary" block icon={<Download className="size-4" />} onClick={() => void exportJson()}>
          Download full backup (JSON)
        </Button>
        <div className="grid grid-cols-3 gap-2">
          <Button size="sm" onClick={() => void exportCsv('workouts')}>
            Workouts CSV
          </Button>
          <Button size="sm" onClick={() => void exportCsv('activities')}>
            Activities CSV
          </Button>
          <Button size="sm" onClick={() => void exportCsv('measurements')}>
            Body CSV
          </Button>
        </div>
        <p className="text-xs text-muted">Backups contain your structured records (workouts, activities, programs, measurements, nutrition, settings). They don’t include photo files from shared posts.</p>
      </Card>

      <SectionTitle>Restore from a backup</SectionTitle>
      <RestoreSection />

      <SectionTitle>Delete</SectionTitle>
      <Card className="p-4 space-y-3">
        {auth.status === 'signed_in' || auth.status === 'expired' ? (
          <>
            <p className="text-sm text-muted">Deleting your account removes your records and photos from the server and this device.</p>
            <DeleteAccountButton />
          </>
        ) : (
          <>
            <p className="text-sm text-muted">Remove all records stored on this device.</p>
            <Button variant="danger" onClick={() => setWipe(true)}>
              Delete all data on this device…
            </Button>
          </>
        )}
      </Card>
      <ConfirmDialog
        open={wipe}
        danger
        title="Delete everything on this device?"
        body="All workouts, activities, programs, measurements and nutrition records stored here will be permanently removed. Download a backup first if you might want them."
        confirmLabel="Delete everything"
        onCancel={() => setWipe(false)}
        onConfirm={async () => {
          await deleteAccountDb(db.accountKey);
          location.assign('/');
        }}
      />
    </Page>
  );
}

/** Restore: validate the whole file, show exactly what will happen, then import in one transaction. */
function RestoreSection() {
  const { db } = useApp();
  const toast = useToast();
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [selected, setSelected] = useState<Set<SyncedEntity>>(new Set());
  const [existing, setExisting] = useState<ExistingRule>('keep');
  const [parts, setParts] = useState<Partial<Record<SingletonPart, ExistingRule>>>({});
  const [importError, setImportError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setPreview(null);
    setExisting('keep');
    setParts({});
  };
  const singletonOnDevice = !!preview?.singleton?.onDevice;
  const entities = preview ? [...selected, ...(singletonOnDevice && Object.values(parts).includes('replace') ? (['account_state'] as SyncedEntity[]) : [])] : [];
  const opts = { entities, existing, singleton: parts };
  const plan = preview ? describePlan(preview, opts) : null;
  const anyDiffers = !!preview?.rows.some((r) => r.entity !== 'account_state' && r.differs > 0);

  return (
    <Card className="p-4 space-y-3">
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="sr-only"
        aria-label="Choose backup file"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          setImportError(null);
          reset();
          try {
            if (f.size > MAX_BACKUP_BYTES) throw new Error('That file is too large to be a backup.');
            const p = await previewImport(db, parseBackup(await f.text()));
            setPreview(p);
            setSelected(new Set(p.rows.filter((r) => r.newCount > 0 && !(r.entity === 'account_state' && p.singleton?.onDevice)).map((r) => r.entity)));
          } catch (err) {
            setImportError((err as Error).message);
          }
        }}
      />
      <Button block icon={<FileUp className="size-4" />} onClick={() => fileRef.current?.click()}>
        Choose backup file…
      </Button>
      {importError && (
        <Notice tone="danger">
          <span role="alert" className="whitespace-pre-line">
            {importError}
          </span>
        </Notice>
      )}
      {preview && plan && (
        <div className="space-y-3">
          <p className="text-sm">Backup from {new Date(preview.backup.exportedAt).toLocaleString()}. The file was checked and nothing has changed yet.</p>
          <details className="text-xs text-muted rounded-xl border border-line px-3 py-2">
            <summary className="min-h-11 flex items-center cursor-pointer text-sm text-ink">How restoring works</summary>
            <ul className="list-disc pl-4 space-y-1 pb-2">
              <li>Records are matched by their id. Records you don’t have are added; identical ones are skipped, so nothing is duplicated.</li>
              <li>Records on this device that differ from the backup are kept as they are unless you choose to use the backup’s version.</li>
              <li>Settings, your private profile, nutrition targets and favourites are only replaced if you choose that for each one.</li>
              <li>Records you deleted on this device aren’t brought back.</li>
              <li>Everything is imported in one step: if something goes wrong, nothing is changed.</li>
            </ul>
          </details>
          {preview.repaired.sets > 0 && (
            <Notice tone="warn">
              {preview.repaired.sets} set{preview.repaired.sets === 1 ? '' : 's'} in {preview.repaired.sessions} workout{preview.repaired.sessions === 1 ? '' : 's'} have missing or impossible values. They’ll be imported with those values left blank, and sets that can’t count as done are imported as not done.
            </Notice>
          )}
          {preview.warnings.map((w) => (
            <Notice key={w}>{w}</Notice>
          ))}
          {preview.unknownEntities.length > 0 && <Notice>Some parts of this file aren’t used by this version of the app and will be ignored.</Notice>}
          <div className="divide-y divide-line rounded-xl border border-line px-3">
            {preview.rows
              .filter((r) => !(r.entity === 'account_state' && singletonOnDevice))
              .map((r) => {
                const actionable = r.newCount > 0 || (existing === 'replace' && r.differs > 0);
                return (
                  <div key={r.entity}>
                    <Toggle
                      label={ENTITY_LABELS[r.entity]}
                      description={`${r.newCount} new · ${r.existing} already here${r.differs ? ` (${r.differs} different)` : ''}`}
                      checked={selected.has(r.entity) && actionable}
                      disabled={!actionable}
                      onChange={(v) => {
                        const s = new Set(selected);
                        if (v) s.add(r.entity);
                        else s.delete(r.entity);
                        setSelected(s);
                      }}
                    />
                    {r.notes.map((n) => (
                      <p key={n} className="text-xs text-muted pb-2">
                        {n}
                      </p>
                    ))}
                  </div>
                );
              })}
          </div>
          {anyDiffers && (
            <div className="space-y-1.5">
              <span className="text-sm font-medium">Records that differ from the backup</span>
              <Segmented<ExistingRule>
                label="Records that differ from the backup"
                value={existing}
                onChange={(v) => {
                  setExisting(v);
                  if (v === 'replace') setSelected(new Set([...selected, ...preview.rows.filter((r) => r.differs > 0 && r.entity !== 'account_state').map((r) => r.entity)]));
                }}
                options={[
                  { value: 'keep', label: 'Keep this device’s' },
                  { value: 'replace', label: 'Use the backup’s' },
                ]}
              />
            </div>
          )}
          {singletonOnDevice && preview.singleton && (
            <div className="rounded-xl border border-line p-3 space-y-3">
              <p className="text-sm font-medium">{ENTITY_LABELS.account_state}</p>
              {SINGLETON_PARTS.filter((x) => preview.singleton!.differs[x.key]).length === 0 ? (
                <p className="text-xs text-muted">Same as on this device. Nothing to change.</p>
              ) : (
                SINGLETON_PARTS.filter((x) => preview.singleton!.differs[x.key]).map((x) => (
                  <div key={x.key} className="space-y-1.5">
                    <span className="text-xs text-muted">{x.label}</span>
                    <Segmented<ExistingRule>
                      size="sm"
                      label={x.label}
                      value={parts[x.key] ?? 'keep'}
                      onChange={(v) => setParts({ ...parts, [x.key]: v })}
                      options={[
                        { value: 'keep', label: 'Keep current' },
                        { value: 'replace', label: 'Use backup' },
                      ]}
                    />
                  </div>
                ))
              )}
            </div>
          )}
          <p className="text-sm text-muted" role="status">
            {plan.add + plan.replace === 0
              ? 'Nothing selected to import.'
              : `Will add ${plan.add}${plan.replace ? `, replace ${plan.replace}` : ''}${plan.keep ? ` and keep ${plan.keep} as they are on this device` : ''}.`}
          </p>
          <div className="flex gap-2">
            <Button
              variant="primary"
              disabled={plan.add + plan.replace === 0}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                setImportError(null);
                try {
                  const r = await applyImport(db, preview.backup, opts);
                  toast.show(`Restored ${r.written} record${r.written === 1 ? '' : 's'}${r.replaced ? ` (${r.replaced} replaced)` : ''}`, { tone: 'success' });
                  reset();
                } catch (e) {
                  const msg = (e as Error).message;
                  setImportError(/Nothing was/.test(msg) ? msg : `${msg} Nothing was changed.`);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Import selected
            </Button>
            <Button variant="ghost" onClick={reset}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function SyncSection() {
  const { db, auth, online } = useApp();
  const toast = useToast();
  const s = useSyncStatus();
  const conflicts = useLiveQuery(() => db.conflicts.toArray(), [db]) ?? [];
  const label: Record<typeof s.phase, string> = {
    disabled: 'Off',
    idle: 'Up to date',
    syncing: 'Syncing…',
    offline: 'Waiting for connection',
    paused_auth: 'Paused: sign in again',
    error: 'Having trouble: will retry',
  };
  return (
    <>
      <SectionTitle id="sync">Backup & sync</SectionTitle>
      <Card className="p-4 space-y-3 text-sm">
        <div className="flex items-center justify-between">
          <span>Status</span>
          <Badge tone={s.phase === 'idle' ? 'accent' : s.phase === 'error' || s.phase === 'paused_auth' ? 'warn' : 'neutral'}>{label[s.phase]}</Badge>
        </div>
        <div className="flex justify-between text-muted">
          <span>Changes waiting</span>
          <span className="tabular">{s.pending}</span>
        </div>
        {s.lastSyncedAt && <p className="text-muted">Last synced {new Date(s.lastSyncedAt).toLocaleTimeString()}</p>}
        {s.lastError && s.phase !== 'idle' && <p className="text-xs text-muted">{s.lastError}</p>}
        <div className="flex gap-2">
          <Button size="sm" icon={<RefreshCw className="size-4" />} disabled={!online || auth.status !== 'signed_in'} onClick={() => void syncNow().then(() => toast.show('Sync finished'))}>
            Sync now
          </Button>
          {s.failing > 0 && (
            <Button size="sm" onClick={() => void retryFailed(db)}>
              Retry {s.failing} failed
            </Button>
          )}
        </div>
      </Card>
      {conflicts.length > 0 && (
        <Card className="p-4 mt-3 space-y-4">
          <p className="text-sm">These were changed on more than one device. Nothing has been lost. Choose what to keep.</p>
          {conflicts.map((c) => (
            <ConflictRow key={c.id} c={c} />
          ))}
        </Card>
      )}
    </>
  );
}

function describe(rec: unknown): string {
  const r = rec as Record<string, unknown> | null;
  if (!r) return 'Deleted';
  const parts = [r.name, (r as { template?: { name?: string } }).template?.name, r.date, r.kind, r.type].filter((x) => typeof x === 'string') as string[];
  const exercises = Array.isArray(r.exercises) ? `${(r.exercises as { sets: { completed?: boolean }[] }[]).reduce((n, e) => n + e.sets.filter((s) => s.completed).length, 0)} completed sets` : null;
  const when = typeof r.updatedAt === 'number' ? `edited ${new Date(r.updatedAt).toLocaleString()}` : null;
  return [parts.slice(0, 2).join(' · '), exercises, when].filter(Boolean).join(': ') || 'Record';
}

function ConflictRow({ c }: { c: SyncConflict & { remoteDeleted?: boolean } }) {
  const { db } = useApp();
  const toast = useToast();
  const go = async (choice: 'keep_local' | 'keep_remote' | 'keep_both') => {
    await resolveConflict(db, c.id, choice);
    toast.show('Resolved', { tone: 'success' });
  };
  return (
    <div className="rounded-xl border border-line p-3 space-y-2 text-sm">
      <div className="font-medium">{ENTITY_LABELS[c.entity]}</div>
      <div className="text-xs text-muted">This device: {describe(c.local)}</div>
      <div className="text-xs text-muted">Other device: {c.remoteDeleted ? 'deleted it' : describe(c.remote)}</div>
      <div className="flex flex-wrap gap-2">
        {!c.remoteDeleted && (
          <Button size="sm" onClick={() => void go('keep_local')}>
            Keep this device’s
          </Button>
        )}
        <Button size="sm" onClick={() => void go('keep_remote')}>
          {c.remoteDeleted ? 'Accept deletion' : 'Keep other version'}
        </Button>
        <Button size="sm" variant="primary" onClick={() => void go('keep_both')}>
          {c.remoteDeleted ? 'Restore as a copy' : 'Keep both'}
        </Button>
      </div>
    </div>
  );
}
