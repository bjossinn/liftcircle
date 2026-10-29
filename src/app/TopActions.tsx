import { Link } from 'react-router';
import { Bell, Settings, UserRound, Users } from 'lucide-react';
import { useApp } from '@/state/app';
import { useUnreadCount } from '@/features/social/useUnreadCount';

/** Secondary navigation shown in the header of main tab pages. */
export function TopActions() {
  const { auth } = useApp();
  const unread = useUnreadCount();
  const signedIn = auth.status === 'signed_in' || auth.status === 'expired';
  const cls = 'relative inline-flex items-center justify-center size-11 rounded-xl hover:bg-surface-2 text-ink';
  return (
    <>
      {signedIn && (
        <>
          <Link to="/friends" className={cls} aria-label="Friends" title="Friends">
            <Users className="size-5" />
          </Link>
          <Link to="/notifications" className={cls} aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'} title="Notifications">
            <Bell className="size-5" />
            {unread > 0 && <span className="absolute top-2.5 right-2.5 size-2 rounded-full bg-accent" aria-hidden />}
          </Link>
          <Link to="/profile" className={cls} aria-label="Your profile" title="Profile">
            <UserRound className="size-5" />
          </Link>
        </>
      )}
      <Link to="/settings" className={cls} aria-label="Settings" title="Settings">
        <Settings className="size-5" />
      </Link>
    </>
  );
}
