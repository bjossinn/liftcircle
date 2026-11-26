import { useState } from 'react';
import { useNavigate } from 'react-router';
import { LogOut } from 'lucide-react';
import { useApp } from '@/state/app';
import { Button, ConfirmDialog, Input, Notice, Sheet, Toggle } from '@/components/ui';
import { supabase } from '@/backend/supabase';
import { clearSignedUrlCache, socialApi } from '@/backend/social';
import { deleteAccountDb } from '@/db/db';
import { syncNow, unsyncedCount } from '@/sync/engine';
import { buildBackup, downloadText, stamp } from './backup';
import { useToast } from '@/components/toast';
import { getLanguage, t as tNow, useT } from '@/i18n';
import { knownErrorText } from './errorText';

/**
 * Sign-out handles unsynced data explicitly: sync first, then (if anything is still unsynced)
 * the user chooses to export, keep it on this device, or discard it.
 */
export function SignOutButton() {
  const { db, auth, online, finishSignOut } = useApp();
  const toast = useToast();
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [unsynced, setUnsynced] = useState(0);
  const [removeLocal, setRemoveLocal] = useState(true);
  const [busy, setBusy] = useState(false);

  const begin = async () => {
    setBusy(true);
    try {
      if (online && auth.status === 'signed_in') await syncNow().catch(() => {});
      const n = await unsyncedCount(db);
      setUnsynced(n);
      setRemoveLocal(n === 0); // never default to deleting unsynced changes
      setOpen(true);
    } finally {
      setBusy(false);
    }
  };

  const complete = async (remove: boolean) => {
    setBusy(true);
    const accountKey = db.accountKey;
    try {
      clearSignedUrlCache();
      finishSignOut(); // switch to the guest database first so no screen keeps using account data
      await supabase()?.auth.signOut({ scope: 'local' });
      if (remove) await deleteAccountDb(accountKey);
      toast.show(remove ? t('settings.signedOutRemoved') : t('settings.signedOutKept'));
    } catch (e) {
      toast.show(knownErrorText(e), { tone: 'error' });
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  return (
    <>
      <Button icon={<LogOut className="size-4" />} onClick={() => void begin()} loading={busy}>
        {/* i18n: no approved Icelandic copy */}
        Sign out
      </Button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={t('settings.signOutConfirm')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant={unsynced > 0 && removeLocal ? 'danger' : 'primary'} loading={busy} onClick={() => void complete(removeLocal)}>
              {/* i18n: no approved Icelandic copy */}
              Sign out
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {unsynced > 0 ? (
            <Notice tone="warn">{unsyncedText(unsynced, online)}</Notice>
          ) : (
            <p className="text-sm text-muted">{t('settings.allBackedUp')}</p>
          )}
          {unsynced > 0 && (
            <Button
              block
              onClick={async () => {
                downloadText(`hard-earned-backup-${stamp()}.json`, JSON.stringify(await buildBackup(db), null, 2));
                toast.show(t('settings.backupDownloaded'));
              }}
            >
              {t('settings.backupFirst')}
            </Button>
          )}
          <Toggle
            label={t('settings.removeLocalData')}
            description={unsynced > 0 ? t('settings.keepUnsyncedHelp') : t('settings.removeLocalHelp')}
            checked={removeLocal}
            onChange={setRemoveLocal}
          />
        </div>
      </Sheet>
    </>
  );
}

/** Real account deletion: server removes owned records and media; then local data is removed. */
export function DeleteAccountButton() {
  const { db, auth, online, finishSignOut } = useApp();
  const nav = useNavigate();
  const toast = useToast();
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (auth.status !== 'signed_in' && auth.status !== 'expired') return null;
  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}>
        {t('settings.deleteAccount')}
      </Button>
      <ConfirmDialog
        open={open}
        danger
        title={t('settings.deleteAccountConfirm')}
        body={t('settings.deleteAccountHelp')}
        confirmLabel={t('settings.deleteEverything')}
        busy={busy}
        onCancel={() => setOpen(false)}
        onConfirm={async () => {
          if (confirm !== 'DELETE') return setError(t('settings.deleteConfirmValidation'));
          if (!online) return setError(t('settings.deleteOnlineRequired'));
          setBusy(true);
          setError(null);
          const key = db.accountKey;
          try {
            await socialApi.deleteAccount();
            finishSignOut();
            await deleteAccountDb(key);
            toast.show(t('settings.accountDeleted'));
            nav('/', { replace: true });
          } catch (e) {
            setError(knownErrorText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="mt-3 space-y-2">
          <Input label={t('settings.deleteConfirmLabel')} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoCapitalize="characters" error={error} />
        </div>
      </ConfirmDialog>
    </>
  );
}

/** Unsynced-changes warning. English keeps its singular wording for one change; the Icelandic copy is count-neutral. */
function unsyncedText(count: number, online: boolean): string {
  if (count === 1 && getLanguage() === 'en') {
    return `1 change hasn’t been backed up yet${online ? '' : ' because you’re offline'}. Export a backup or keep the data on this device so nothing is lost.`;
  }
  return tNow(online ? 'settings.unsyncedSignOut' : 'settings.unsyncedOfflineSignOut', { count });
}
