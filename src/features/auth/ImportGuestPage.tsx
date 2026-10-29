import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { ChevronLeft, Upload } from 'lucide-react';
import { Button, Card, EmptyState, IconButton, Notice, Page, Spinner, Toggle } from '@/components/ui';
import { useApp } from '@/state/app';
import { useToast } from '@/components/toast';
import { clearGuestData, dismissGuestImport, importGuestData, previewGuestImport, type ImportRow } from './guestImport';
import type { SyncedEntity } from '@/db/db';

export default function ImportGuestPage() {
  const nav = useNavigate();
  const toast = useToast();
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
    <IconButton label="Back" onClick={() => nav(-1)}>
      <ChevronLeft className="size-6" />
    </IconButton>
  );
  if (!signedIn)
    return (
      <Page title="Import" back={back}>
        <EmptyState title="Sign in first" body="Sign in to the account you want to import into." action={<Button onClick={() => nav('/auth')}>Sign in</Button>} />
      </Page>
    );
  if (error) return <Page title="Import" back={back}><Notice tone="danger">{error}</Notice></Page>;
  if (!rows) return <Spinner />;
  const total = rows.filter((r) => selected.has(r.entity)).reduce((n, r) => n + r.toImport, 0);

  return (
    <Page title="Import guest records" back={back}>
      <p className="text-sm text-muted mb-4">
        These were logged on this device before you signed in{auth.email ? ` as ${auth.email}` : ''}. Choose what to add to this account. Records already in your account are kept as they are and won’t be duplicated.
      </p>
      {rows.length === 0 ? (
        <EmptyState title="Nothing to import" />
      ) : (
        <Card className="divide-y divide-line">
          {rows.map((r) => (
            <div key={r.entity} className="px-4">
              <Toggle
                label={r.label}
                description={`${r.toImport} new${r.alreadyThere ? ` · ${r.alreadyThere} already in your account` : ''}`}
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
        <Toggle label="Remove guest copy after importing" description="Keeps this device tidy. Imported records stay in your account." checked={clearAfter} onChange={setClearAfter} />
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
              toast.show(`Imported ${n} record${n === 1 ? '' : 's'}`, { tone: 'success' });
              nav('/', { replace: true });
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Import {total} record{total === 1 ? '' : 's'}
        </Button>
        <Button
          variant="ghost"
          onClick={async () => {
            await dismissGuestImport(auth.userId!);
            nav('/', { replace: true });
          }}
        >
          Not now
        </Button>
      </div>
    </Page>
  );
}
