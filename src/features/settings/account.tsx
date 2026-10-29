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

/**
 * Sign-out handles unsynced data explicitly: sync first, then (if anything is still unsynced)
 * the user chooses to export, keep it on this device, or discard it.
 */
export function SignOutButton() {
  const { db, auth, online, finishSignOut } = useApp();
  const toast = useToast();
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
      toast.show(remove ? 'Signed out and removed this account’s data from this device' : 'Signed out. Your data stays on this device for next time.');
    } catch (e) {
      toast.show((e as Error).message, { tone: 'error' });
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  return (
    <>
      <Button icon={<LogOut className="size-4" />} onClick={() => void begin()} loading={busy}>
        Sign out
      </Button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Sign out?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant={unsynced > 0 && removeLocal ? 'danger' : 'primary'} loading={busy} onClick={() => void complete(removeLocal)}>
              Sign out
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {unsynced > 0 ? (
            <Notice tone="warn">
              {unsynced} change{unsynced === 1 ? ' hasn’t' : 's haven’t'} been backed up yet{online ? '' : ' because you’re offline'}. Export a backup or keep the data on this device so nothing is lost.
            </Notice>
          ) : (
            <p className="text-sm text-muted">Everything is backed up to your account.</p>
          )}
          {unsynced > 0 && (
            <Button
              block
              onClick={async () => {
                downloadText(`liftcircle-backup-${stamp()}.json`, JSON.stringify(await buildBackup(db), null, 2));
                toast.show('Backup downloaded');
              }}
            >
              Download a backup first
            </Button>
          )}
          <Toggle
            label="Remove this account’s data from this device"
            description={
              unsynced > 0
                ? 'Unsynced changes would be lost. Leave this off to keep them here — they’ll back up when you sign in again with the same account.'
                : 'Recommended on shared devices. Signing in again downloads it from your account.'
            }
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
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (auth.status !== 'signed_in' && auth.status !== 'expired') return null;
  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}>
        Delete account…
      </Button>
      <ConfirmDialog
        open={open}
        danger
        title="Delete your account permanently?"
        body="This deletes your profile, posts, photos, comments, friends and all synced workouts, activities, measurements and nutrition records from the server, then removes them from this device. It can’t be undone. Consider downloading a backup first."
        confirmLabel="Delete everything"
        busy={busy}
        onCancel={() => setOpen(false)}
        onConfirm={async () => {
          if (confirm !== 'DELETE') return setError('Type DELETE to confirm.');
          if (!online) return setError('You need to be online to delete your account.');
          setBusy(true);
          setError(null);
          const key = db.accountKey;
          try {
            await socialApi.deleteAccount();
            finishSignOut();
            await deleteAccountDb(key);
            toast.show('Your account was deleted');
            nav('/', { replace: true });
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="mt-3 space-y-2">
          <Input label="Type DELETE to confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoCapitalize="characters" error={error} />
        </div>
      </ConfirmDialog>
    </>
  );
}
