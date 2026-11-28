import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { ChevronLeft, Upload } from 'lucide-react';
import { Button, Card, EmptyState, IconButton, Notice, Page, Spinner, Toggle } from '@/components/ui';
import { useApp } from '@/state/app';
import { useToast } from '@/components/toast';
import { clearGuestData, dismissGuestImport, importGuestData, previewGuestImport, type ImportRow } from './guestImport';
import type { SyncedEntity } from '@/db/db';
import { useT } from '@/i18n';

export default function ImportGuestPage() {
  const nav = useNavigate();
  const toast = useToast();
  const { t, tp } = useT();
  const { db, auth } = useApp();
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [selected, setSelected] = useState<Set<SyncedEntity>>(new Set());
  const [clearAfter, setClearAfter] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signedIn = !db.isGuest && auth.status === 'signed_in' && auth.userId === db.accountKey;

  useEffect(() => {
    if (!signedIn) return;
    previewGuestImport(db)
      .then((r) => {
        setRows(r);
        setSelected(new Set(r.filter((x) => x.toImport > 0).map((x) => x.entity)));
      })
      .catch((e) => setError((e as Error).message));
  }, [db, signedIn]);

  const back = (
    <IconButton label={t('common.back')} onClick={() => nav(-1)}>
      <ChevronLeft className="size-6" />
    </IconButton>
  );
  if (!signedIn)
    return (
      <Page title={t('auth.import')} back={back}>
        <EmptyState title={t('auth.sign_in_first')} body={t('auth.sign_in_to_the_account_you')} action={<Button onClick={() => nav('/auth')}>{t('settings.signIn')}</Button>} />
      </Page>
    );
  if (error) return <Page title={t('auth.import')} back={back}><Notice tone="danger">{error}</Notice></Page>;
  if (!rows) return <Spinner />;
  const total = rows.filter((r) => selected.has(r.entity)).reduce((n, r) => n + r.toImport, 0);

  return (
    <Page title={t('auth.import_guest_records')} back={back}>
      <p className="text-sm text-muted mb-4">
        {auth.email ? t('auth.loggedBeforeSignInAs', { email: auth.email }) : t('auth.these_were_logged_on_this_device')}
      </p>
      {rows.length === 0 ? (
        <EmptyState title={t('auth.nothing_to_import')} />
      ) : (
        <Card className="divide-y divide-line">
          {rows.map((r) => (
            <div key={r.entity} className="px-4">
              <Toggle
                label={r.label}
                description={r.alreadyThere ? t('auth.newAndExisting', { count: r.toImport, existing: r.alreadyThere }) : t('auth.x_newx', { count: r.toImport })}
                checked={selected.has(r.entity)}
                disabled={r.toImport === 0}
                onChange={(v) => {
                  const s = new Set(selected);
                  if (v) s.add(r.entity);
                  else s.delete(r.entity);
                  setSelected(s);
                }}
              />
            </div>
          ))}
        </Card>
      )}
      <Card className="px-4 mt-4">
        <Toggle label={t('auth.remove_guest_copy_after_importing')} description={t('auth.keeps_this_device_tidy_imported_records')} checked={clearAfter} onChange={setClearAfter} />
      </Card>
      <div className="flex flex-col gap-2 mt-6">
        <Button
          variant="primary"
          size="lg"
          icon={<Upload className="size-5" />}
          disabled={total === 0}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const n = await importGuestData(db, auth.userId!, [...selected]);
              if (clearAfter) await clearGuestData();
              toast.show(tp('auth.importedRecords', n), { tone: 'success' });
              nav('/', { replace: true });
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {tp('auth.importRecords', total)}
        </Button>
        <Button
          variant="ghost"
          onClick={async () => {
            await dismissGuestImport(auth.userId!);
            nav('/', { replace: true });
          }}
        >
          {t('workout.share.notNow')}
        </Button>
      </div>
    </Page>
  );
}
