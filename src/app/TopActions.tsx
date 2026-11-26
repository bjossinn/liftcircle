import { Link } from 'react-router';
import { Bell, UserRound } from 'lucide-react';
import { useApp } from '@/state/app';
import { useUnreadCount } from '@/features/social/useUnreadCount';
import { useT } from '@/i18n';

/**
 * Header actions on the main tab pages: Profile (the way to Nutrition, Friends and Settings), plus Notifications with an
 * unread dot when signed in. Kept to two icons so the header stays calm.
 */
export function TopActions() {
  const { auth } = useApp();
  const unread = useUnreadCount();
  const { t } = useT();
  const signedIn = auth.status === 'signed_in' || auth.status === 'expired';
  const cls = 'relative inline-flex items-center justify-center size-11 rounded-xl hover:bg-surface-2 text-ink';
  return (
    <>
      {signedIn && (
        <Link to="/notifications" className={cls} aria-label={unread ? t('nav.notificationsUnread', { count: unread }) : t('nav.notifications')} title={t('nav.notifications')}>
          <Bell className="size-5" />
          {unread > 0 && <span className="absolute top-2.5 right-2.5 size-2 rounded-full bg-ember" aria-hidden />}
        </Link>
      )}
      <Link to="/profile" className={cls} aria-label={t('nav.profile')} title={t('nav.profileHint')}>
        <UserRound className="size-5" />
      </Link>
    </>
  );
}
