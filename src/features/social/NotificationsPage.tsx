import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { BadgeCheck, Bell, ChevronLeft, ClipboardCheck, ClipboardList, Heart, HeartHandshake, MessageCircle, RefreshCw, UserCheck, UserPlus } from 'lucide-react';
import { EmptyState, ErrorState, IconButton, Notice, Page, Spinner, cx } from '@/components/ui';
import { socialApi } from '@/backend/social';
import type { AppNotification, SocialNotificationType } from '@/domain/types';
import { useApp, useSettings } from '@/state/app';
import { friendlyError } from '@/social/pendingPosts';
import { AccessNotice, Avatar, Time, useSocialAccess } from './common';
import { feedHome } from './feedHome';
import { allNotificationTypesEnabled, enabledNotificationTypes, notifyUnreadChanged } from './useUnreadCount';
import { t, useT, type Language, type MessageKey } from '@/i18n';

/** Verb phrases that follow the actor's name ("Anna liked your post" / "Anna lækaði færsluna þína"). */
const SOCIAL_TEXT: Record<SocialNotificationType, MessageKey> = {
  friend_request: 'social.notif.friend_request',
  friend_accept: 'social.notif.friend_accept',
  like: 'social.notif.like',
  comment: 'social.notif.comment',
};
const ICON: Record<AppNotification['type'], typeof Bell> = {
  friend_request: UserPlus,
  friend_accept: UserCheck,
  like: Heart,
  comment: MessageCircle,
  coach_request: HeartHandshake,
  coach_request_accepted: HeartHandshake,
  coach_request_declined: HeartHandshake,
  coach_request_cancelled: HeartHandshake,
  coach_ended: HeartHandshake,
  coach_message: MessageCircle,
  coach_proposal: ClipboardList,
  coach_proposal_response: ClipboardList,
  coach_checkin: ClipboardCheck,
  coach_feedback: MessageCircle,
  coach_application: BadgeCheck,
  coach_status: BadgeCheck,
};

/**
 * What a notification says. Coaching notifications carry ids only, never message text.
 * `me` decides direction where the same type reaches both sides (coach vs client, applicant vs admin).
 */
export function describeNotification(n: AppNotification, me: string | undefined, language?: Language): { who: string | null; text: string } {
  const tr = (key: MessageKey) => t(key, undefined, language);
  const actorName = n.actor?.displayName || (n.actor?.username ? `@${n.actor.username}` : tr('social.someone'));
  const iAmCoach = !!me && n.coachId === me;
  switch (n.type) {
    case 'friend_request':
    case 'friend_accept':
    case 'like':
    case 'comment':
      return { who: actorName, text: tr(SOCIAL_TEXT[n.type]) };
    case 'coach_request':
      return { who: actorName, text: tr('social.notif.coach_request') };
    case 'coach_request_accepted':
      return { who: actorName, text: tr('social.notif.coach_request_accepted') };
    case 'coach_request_declined':
      return { who: actorName, text: tr('social.notif.coach_request_declined') };
    case 'coach_request_cancelled':
      return { who: actorName, text: tr('social.notif.coach_request_cancelled') };
    case 'coach_ended':
      return { who: actorName, text: tr('social.notif.coach_ended') };
    case 'coach_message':
      return { who: actorName, text: tr('social.notif.coach_message') };
    case 'coach_proposal':
      return { who: actorName, text: tr('social.notif.coach_proposal') };
    case 'coach_proposal_response':
      return { who: actorName, text: tr('social.notif.coach_proposal_response') };
    case 'coach_checkin':
      return { who: actorName, text: tr(iAmCoach ? 'social.notif.coach_checkin_sent' : 'social.notif.coach_checkin_replied') };
    case 'coach_feedback':
      return { who: actorName, text: tr('social.notif.coach_feedback') };
    case 'coach_application':
      return iAmCoach
        ? { who: null, text: tr('social.notif.application_reviewed') }
        : { who: actorName, text: tr('social.notif.application_submitted') };
    case 'coach_status':
      return { who: null, text: tr(iAmCoach ? 'social.notif.my_status_changed' : 'social.notif.coach_status_changed') };
  }
}

export function linkFor(n: AppNotification, me?: string): string {
  const iAmCoach = !!me && n.coachId === me;
  const rel = n.relationshipId;
  switch (n.type) {
    case 'friend_request':
      return '/friends';
    case 'friend_accept':
      return n.actor?.username ? `/u/${n.actor.username}` : '/friends';
    case 'like':
    case 'comment':
      return n.postId ? `/feed/post/${n.postId}` : feedHome().path;
    case 'coach_request':
    case 'coach_request_cancelled':
      return '/coaching/dashboard';
    case 'coach_request_accepted':
    case 'coach_request_declined':
    case 'coach_feedback':
      return '/coaching/my';
    case 'coach_ended':
      return iAmCoach ? '/coaching/dashboard' : '/coaching/my';
    case 'coach_message':
      return rel ? `/coaching/messages/${rel}` : '/coaching';
    case 'coach_proposal':
      return n.proposalId ? `/coaching/proposal/${n.proposalId}` : '/coaching/my';
    case 'coach_proposal_response':
      return rel ? `/coaching/client/${rel}/program` : '/coaching/dashboard';
    case 'coach_checkin':
      if (!rel) return '/coaching';
      return iAmCoach ? `/coaching/client/${rel}` : `/coaching/checkin/${rel}`;
    case 'coach_application':
      return iAmCoach || !n.coachId ? '/coaching/apply' : `/coaching/admin/${n.coachId}`;
    case 'coach_status':
      return iAmCoach ? '/coaching/apply' : '/coaching/my';
  }
}

export default function NotificationsPage() {
  const nav = useNavigate();
  const { t } = useT();
  const { access } = useSocialAccess();
  return (
    <Page
      title={t('nav.notifications')}
      back={
        <IconButton label={t('common.back')} onClick={() => nav(-1)}>
          <ChevronLeft className="size-6" />
        </IconButton>
      }
    >
      {access !== 'ok' ? <AccessNotice access={access} what="notifications" /> : <NotificationList />}
    </Page>
  );
}

function NotificationList() {
  const { t, language } = useT();
  const settings = useSettings();
  const { auth } = useApp();
  const me = auth.userId;
  const { friendRequests, likes, comments, coaching } = settings.notifications;
  const types = useMemo(() => enabledNotificationTypes({ friendRequests, likes, comments, coaching }), [friendRequests, likes, comments, coaching]);
  const hidden = !allNotificationTypesEnabled({ friendRequests, likes, comments, coaching });
  const [items, setItems] = useState<AppNotification[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Remember what was unread when shown, so styling stays until the user leaves.
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const all = await socialApi.listNotifications(50);
      const visible = all.filter((n) => types.includes(n.type));
      const unread = visible.filter((n) => !n.readAt).map((n) => n.id);
      setItems(visible);
      setFreshIds((prev) => new Set([...prev, ...unread]));
      if (unread.length) {
        socialApi
          .markNotificationsRead(unread)
          .then(notifyUnreadChanged)
          .catch(() => {});
      }
    } catch (e) {
      setError(friendlyError(e, t('social.couldnt_load_notifications')));
    } finally {
      setRefreshing(false);
    }
  }, [types, t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="flex justify-end -mt-1 mb-1">
        <IconButton label={t('social.refresh_notifications')} onClick={() => void load()} disabled={refreshing}>
          <RefreshCw className={cx('size-5', refreshing && 'animate-spin')} />
        </IconButton>
      </div>
      {hidden && (
        <Notice className="mb-3">
          {t('social.some_notification_types_are_turned_off')}{' '}
          <Link to="/settings" className="font-semibold text-accent inline-flex min-h-11 items-center">
            {t('social.notification_settings')}
          </Link>
        </Notice>
      )}
      {error && !items ? (
        <ErrorState title={t('social.couldnt_load_notifications')} message={error} onRetry={load} />
      ) : !items ? (
        <Spinner label={t('social.loading_notifications')} />
      ) : items.length === 0 ? (
        <EmptyState icon={<Bell className="size-6" aria-hidden />} title={t('social.nothing_new')} body={t('social.friend_requests_likes_comments_and_coaching')} />
      ) : (
        <>
          {error && (
            <Notice tone="warn" className="mb-2">
              {error}
            </Notice>
          )}
          <ul className="flex flex-col gap-1">
            {items.map((n) => {
              const Icon = ICON[n.type];
              const unread = freshIds.has(n.id);
              const { who, text } = describeNotification(n, me, language);
              return (
                <li key={n.id}>
                  <Link to={linkFor(n, me)} className={cx('flex items-center gap-3 rounded-xl px-3 py-2.5 min-h-16 hover:bg-surface-2', unread && 'bg-surface')}>
                    <span className="relative shrink-0">
                      <Avatar profile={n.actor} />
                      <span className="absolute -bottom-1 -right-1 size-5 rounded-full bg-surface-3 border border-line flex items-center justify-center">
                        <Icon className="size-3 text-accent" aria-hidden />
                      </span>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px]">
                        {who ? (
                          <>
                            <span className="font-semibold">{who}</span> {text}
                          </>
                        ) : (
                          text
                        )}
                      </span>
                      <Time iso={n.createdAt} className="text-xs text-muted" />
                    </span>
                    {unread && (
                      <>
                        <span className="size-2 rounded-full bg-ember shrink-0" aria-hidden />
                        <span className="sr-only">{t('social.new')}</span>
                      </>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );
}
