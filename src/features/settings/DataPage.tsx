import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronLeft, Download, FileUp, HardDrive, RefreshCw } from 'lucide-react';
import { useApp } from '@/state/app';
import { Badge, Button, Card, ConfirmDialog, IconButton, Notice, Page, SectionTitle, Segmented, Toggle } from '@/components/ui';
import {
  SINGLETON_PARTS, activitiesCsv, applyImport, buildBackup, countText, describePlan, downloadText, measurementsCsv, parseBackup, previewImport, stamp, workoutsCsv,
  type ExistingRule, type ImportPreview, type SingletonPart,
} from './backup';
import { MAX_BACKUP_BYTES } from './backupSchema';
import { ENTITY_LABELS } from '@/features/auth/guestImport';
import { useExercises } from '@/data/catalog';
import { requestPersistentStorage, deleteAccountDb, type SyncConflict, type SyncedEntity } from '@/db/db';
import { resolveConflict, retryFailed, syncNow, useSyncStatus } from '@/sync/engine';
import { DeleteAccountButton } from './account';
import { useToast } from '@/components/toast';
import { clockText, dateTimeText, getLanguage, locale, t as tNow, useT } from '@/i18n';
import { knownErrorText, restoreErrorText } from './errorText';
import { WorkoutImportSection } from '@/features/import/WorkoutImportSection';

export default function DataPage() {
  const nav = useNavigate();
  const toast = useToast();
  const { t } = useT();
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
      toast.show(t('settings.backupDownloaded'), { tone: 'success' });
    } catch (e) {
      toast.show(knownErrorText(e), { tone: 'error' });
    }
  };
  const exportCsv = async (kind: 'workouts' | 'measurements' | 'activities') => {
    const text =
      kind === 'workouts' ? workoutsCsv(await db.sessions.toArray(), byId) : kind === 'measurements' ? measurementsCsv(await db.measurements.toArray()) : activitiesCsv(await db.activities.toArray());
    downloadText(`hard-earned-${kind}-${stamp()}.csv`, text, 'text/csv');
  };

  return (
    <Page
      title={t('settings.dataTitle')}
      back={
        <IconButton label={t('common.back')} onClick={() => nav(-1)} iconSize="lg">
          <ChevronLeft />
        </IconButton>
      }
    >
      <SectionTitle>{t('settings.onDevice')}</SectionTitle>
      <Card className="p-4 space-y-3 text-sm">
        <div className="flex items-center gap-2">
          <HardDrive className="size-4 text-muted" aria-hidden />
          <span className="flex-1">{t('settings.protectedStorage')}</span>
          <Badge tone={persisted ? 'accent' : 'warn'}>{persisted ? t('settings.yes') : persisted === false ? t('settings.notYet') : t('settings.unknown')}</Badge>
        </div>
        {estimate?.usage != null && (
          <p className="text-muted">
            {t('settings.storageUsage', { size: new Intl.NumberFormat(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false }).format(estimate.usage / 1024 / 1024) })}
          </p>
        )}
        {!persisted && (
          <Button
            size="sm"
            onClick={async () => {
              const r = await requestPersistentStorage();
              setPersisted(!!r);
              toast.show(r ? t('settings.storageProtected') : t('settings.storageNotProtected'), { tone: r ? 'success' : 'warn' });
            }}
          >
            {t('settings.protectStorage')}
          </Button>
        )}
        <p className="text-muted">
          {t('settings.deviceDataHelp')} {db.isGuest ? t('settings.guestBackupHelp') : t('settings.accountBackupHelp')}
        </p>
      </Card>

      {!db.isGuest && <SyncSection />}

      <SectionTitle>{t('settings.backupExport')}</SectionTitle>
      <Card className="p-4 space-y-3">
        <Button variant="primary" block icon={<Download className="size-4" />} onClick={() => void exportJson()}>
          {t('settings.downloadFullBackup')}
        </Button>
        <div className="grid grid-cols-3 gap-2">
          <Button size="sm" onClick={() => void exportCsv('workouts')}>
            {t('settings.exportWorkouts')}
          </Button>
          <Button size="sm" onClick={() => void exportCsv('activities')}>
            {t('settings.exportActivities')}
          </Button>
          <Button size="sm" onClick={() => void exportCsv('measurements')}>
            {t('settings.exportBody')}
          </Button>
        </div>
        <p className="text-xs text-muted">{t('settings.backupContents')}</p>
      </Card>

      <SectionTitle id="import">{t('import.title')}</SectionTitle>
      <WorkoutImportSection key={db.accountKey} />

      <SectionTitle>{t('settings.restoreBackup')}</SectionTitle>
      <RestoreSection />

      <SectionTitle>{t('common.delete')}</SectionTitle>
      <Card className="p-4 space-y-3">
        {auth.status === 'signed_in' || auth.status === 'expired' ? (
          <>
            <p className="text-sm text-muted">{t('settings.deleteAccountDataHelp')}</p>
            <DeleteAccountButton />
          </>
        ) : (
          <>
            <p className="text-sm text-muted">{t('settings.deleteDeviceHelp')}</p>
            <Button variant="danger" onClick={() => setWipe(true)}>
              {t('settings.deleteDevice')}
            </Button>
          </>
        )}
      </Card>
      <ConfirmDialog
        open={wipe}
        danger
        title={t('settings.deleteDeviceConfirm')}
        body={t('settings.deleteDeviceConfirmHelp')}
        confirmLabel={t('settings.deleteEverything')}
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
  const { db, account } = useApp();
  const toast = useToast();
  const { t } = useT();
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
        aria-label={t('settings.chooseBackupAria')}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          setImportError(null);
          reset();
          try {
            if (f.size > MAX_BACKUP_BYTES) {
              setImportError(t('settings.backupTooLarge'));
              return;
            }
            const p = await previewImport(db, parseBackup(await f.text()));
            setPreview(p);
            setSelected(new Set(p.rows.filter((r) => r.newCount > 0 && !(r.entity === 'account_state' && p.singleton?.onDevice)).map((r) => r.entity)));
          } catch (err) {
            setImportError(knownErrorText(err, 'settings.backupImportFailed'));
          }
        }}
      />
      <Button block icon={<FileUp className="size-4" />} onClick={() => fileRef.current?.click()}>
        {t('settings.chooseBackup')}
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
          <p className="text-sm">{t('settings.backupPreview', { dateTime: exportedText(preview.backup.exportedAt, account.settings.timeZone) })}</p>
          <details className="text-xs text-muted rounded-xl border border-line px-3 py-2">
            <summary className="min-h-11 flex items-center cursor-pointer text-sm text-ink">{t('settings.restoreHow')}</summary>
            <ul className="list-disc pl-4 space-y-1 pb-2">
              <li>{t('settings.restoreMatching')}</li>
              <li>{t('settings.restoreKeepLocal')}</li>
              <li>{t('settings.restoreChoices')}</li>
              <li>{t('settings.restoreDeleted')}</li>
              <li>{t('settings.restoreAtomic')}</li>
            </ul>
          </details>
          {preview.repaired.sets > 0 && (
            <Notice tone="warn">{repairedText(preview.repaired.sets, preview.repaired.sessions)}</Notice>
          )}
          {preview.warnings.map((w) => (
            <Notice key={w}>{w}</Notice>
          ))}
          {preview.unknownEntities.length > 0 && <Notice>{t('settings.restoreUnknown')}</Notice>}
          <div className="divide-y divide-line rounded-xl border border-line px-3">
            {preview.rows
              .filter((r) => !(r.entity === 'account_state' && singletonOnDevice))
              .map((r) => {
                const actionable = r.newCount > 0 || (existing === 'replace' && r.differs > 0);
                return (
                  <div key={r.entity}>
                    <Toggle
                      label={ENTITY_LABELS[r.entity]}
                      description={
                        r.differs
                          ? t('settings.restoreCountsDifferent', { newCount: r.newCount, existingCount: r.existing, differentCount: r.differs })
                          : t('settings.restoreCounts', { newCount: r.newCount, existingCount: r.existing })
                      }
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
              <span className="text-sm font-medium">{t('settings.restoreDifferent')}</span>
              <Segmented<ExistingRule>
                label={t('settings.restoreDifferent')}
                value={existing}
                onChange={(v) => {
                  setExisting(v);
                  if (v === 'replace') setSelected(new Set([...selected, ...preview.rows.filter((r) => r.differs > 0 && r.entity !== 'account_state').map((r) => r.entity)]));
                }}
                options={[
                  { value: 'keep', label: t('settings.keepDeviceVersion') },
                  { value: 'replace', label: t('settings.useBackupVersion') },
                ]}
              />
            </div>
          )}
          {singletonOnDevice && preview.singleton && (
            <div className="rounded-xl border border-line p-3 space-y-3">
              <p className="text-sm font-medium">{ENTITY_LABELS.account_state}</p>
              {SINGLETON_PARTS.filter((x) => preview.singleton!.differs[x.key]).length === 0 ? (
                <p className="text-xs text-muted">{t('settings.restoreNoChanges')}</p>
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
                        { value: 'keep', label: t('settings.keepCurrent') },
                        { value: 'replace', label: t('settings.useBackup') },
                      ]}
                    />
                  </div>
                ))
              )}
            </div>
          )}
          <p className="text-sm text-muted" role="status">
            {plan.add + plan.replace === 0
              ? t('settings.restoreNoneSelected')
              : plan.replace
                ? plan.keep
                  ? t('settings.restorePlanAll', { add: plan.add, replace: plan.replace, keep: plan.keep })
                  : t('settings.restorePlanAddReplace', { add: plan.add, replace: plan.replace })
                : plan.keep
                  ? t('settings.restorePlanAddKeep', { add: plan.add, keep: plan.keep })
                  : t('settings.restorePlanAdd', { add: plan.add })}
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
                  toast.show(
                    r.replaced
                      ? countText('settings.restoredReplaced', r.written, `Restored 1 record (${r.replaced} replaced)`, { replaced: r.replaced })
                      : countText('settings.restored', r.written, 'Restored 1 record'),
                    { tone: 'success' },
                  );
                  reset();
                } catch (e) {
                  setImportError(restoreErrorText(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t('settings.importSelected')}
            </Button>
            <Button variant="ghost" onClick={reset}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function SyncSection() {
  const { db, auth, online, account } = useApp();
  const toast = useToast();
  const { t } = useT();
  const s = useSyncStatus();
  const conflicts = useLiveQuery(() => db.conflicts.toArray(), [db]) ?? [];
  const label: Record<typeof s.phase, string> = {
    disabled: t('sync.off'),
    idle: t('sync.upToDate'),
    syncing: t('sync.syncing'),
    offline: t('sync.waitingConnection'),
    paused_auth: t('sync.pausedSignIn'),
    error: t('sync.retrying'),
  };
  return (
    <>
      <SectionTitle id="sync">{t('sync.backupSync')}</SectionTitle>
      <Card className="p-4 space-y-3 text-sm">
        <div className="flex items-center justify-between">
          <span>{t('sync.status')}</span>
          <Badge tone={s.phase === 'idle' ? 'accent' : s.phase === 'error' || s.phase === 'paused_auth' ? 'warn' : 'neutral'}>{label[s.phase]}</Badge>
        </div>
        <div className="flex justify-between text-muted">
          <span>{t('sync.changesWaiting')}</span>
          <span className="tabular">{s.pending}</span>
        </div>
        {s.lastSyncedAt && <p className="text-muted">{t('sync.lastSynced', { time: clockText(s.lastSyncedAt, account.settings.timeZone) })}</p>}
        {s.lastError && s.phase !== 'idle' && <p className="text-xs text-muted">{s.lastError}</p>}
        <div className="flex gap-2">
          <Button size="sm" icon={<RefreshCw className="size-4" />} disabled={!online || auth.status !== 'signed_in'} onClick={() => void syncNow().then(() => toast.show(t('sync.finished')))}>
            {t('sync.now')}
          </Button>
          {s.failing > 0 && (
            <Button size="sm" onClick={() => void retryFailed(db)}>
              {t('sync.retryFailed', { count: s.failing })}
            </Button>
          )}
        </div>
      </Card>
      {conflicts.length > 0 && (
        <Card className="p-4 mt-3 space-y-4">
          <p className="text-sm">{t('sync.conflictHelp')}</p>
          {conflicts.map((c) => (
            <ConflictRow key={c.id} c={c} />
          ))}
        </Card>
      )}
    </>
  );
}

/** A short description of a conflicting record. Names/dates/kinds are stored content and shown as they are. */
function describe(rec: unknown, timeZone?: string): string {
  const r = rec as Record<string, unknown> | null;
  if (!r) return tNow('sync.deleted');
  const parts = [r.name, (r as { template?: { name?: string } }).template?.name, r.date, r.kind, r.type].filter((x) => typeof x === 'string') as string[];
  const exercises = Array.isArray(r.exercises)
    ? tNow('sync.completedSets', { count: (r.exercises as { sets: { completed?: boolean }[] }[]).reduce((n, e) => n + e.sets.filter((s) => s.completed).length, 0) })
    : null;
  const when = typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) ? tNow('sync.editedAt', { dateTime: dateTimeText(r.updatedAt, timeZone) }) : null;
  return [parts.slice(0, 2).join(' · '), exercises, when].filter(Boolean).join(': ') || tNow('sync.record');
}

function ConflictRow({ c }: { c: SyncConflict & { remoteDeleted?: boolean } }) {
  const { db, account } = useApp();
  const toast = useToast();
  const { t } = useT();
  const tz = account.settings.timeZone;
  const go = async (choice: 'keep_local' | 'keep_remote' | 'keep_both') => {
    await resolveConflict(db, c.id, choice);
    toast.show(t('sync.resolved'), { tone: 'success' });
  };
  return (
    <div className="rounded-xl border border-line p-3 space-y-2 text-sm">
      <div className="font-medium">{ENTITY_LABELS[c.entity]}</div>
      <div className="text-xs text-muted">{t('sync.thisDevice', { description: describe(c.local, tz) })}</div>
      <div className="text-xs text-muted">{c.remoteDeleted ? t('sync.deletedOnOtherDevice') : t('sync.otherDevice', { description: describe(c.remote, tz) })}</div>
      <div className="flex flex-wrap gap-2">
        {!c.remoteDeleted && (
          <Button size="sm" onClick={() => void go('keep_local')}>
            {t('settings.keepDeviceVersion')}
          </Button>
        )}
        <Button size="sm" onClick={() => void go('keep_remote')}>
          {c.remoteDeleted ? t('sync.acceptDeletion') : t('sync.keepOther')}
        </Button>
        <Button size="sm" variant="primary" onClick={() => void go('keep_both')}>
          {c.remoteDeleted ? t('sync.restoreCopy') : t('sync.keepBoth')}
        </Button>
      </div>
    </div>
  );
}

/** The backup's export time in the account's time zone; an unreadable value is shown as stored. */
function exportedText(exportedAt: string, timeZone?: string): string {
  const ms = Date.parse(exportedAt);
  return Number.isFinite(ms) ? dateTimeText(ms, timeZone) : exportedAt;
}

/** Repaired-sets notice. English keeps its singular wording; the Icelandic copy is count-neutral. */
function repairedText(sets: number, sessions: number): string {
  if (getLanguage() === 'en' && (sets === 1 || sessions === 1)) {
    return `${sets} set${sets === 1 ? '' : 's'} in ${sessions} workout${sessions === 1 ? '' : 's'} have missing or impossible values. They’ll be imported with those values left blank, and sets that can’t count as done are imported as not done.`;
  }
  return tNow('settings.restoreRepaired', { sets, sessions });
}
