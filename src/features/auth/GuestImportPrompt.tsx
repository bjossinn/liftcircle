import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { Upload } from 'lucide-react';
import { useApp } from '@/state/app';
import { guestImportState } from './guestImport';
import { useT } from '@/i18n';

/** Offers (never performs) moving guest records into the signed-in account. */
export function GuestImportPrompt() {
  const { db, auth } = useApp();
  const { t } = useT();
  const { pathname } = useLocation();
  const [show, setShow] = useState(false);
  useEffect(() => {
    let alive = true;
    if (db.isGuest || auth.status !== 'signed_in' || !auth.userId) return setShow(false);
    guestImportState(auth.userId).then((s) => alive && setShow(s === 'available')).catch(() => {});
    return () => {
      alive = false;
    };
  }, [db, auth.status, auth.userId, pathname]);
  if (!show || pathname === '/import-guest' || pathname.startsWith('/train/session')) return null;
  return (
    <Link to="/import-guest" className="flex items-center gap-2 bg-accent-soft border-b border-accent/30 px-4 py-2 text-sm">
      <Upload className="size-4 text-accent shrink-0" aria-hidden />
      <span className="flex-1">{t('auth.you_have_records_from_before_you')}</span>
    </Link>
  );
}
