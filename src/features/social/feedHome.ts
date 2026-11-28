import { isFeatureEnabled } from '@/config/featureFlags';
import { t } from '@/i18n';

/** Where "back to the feed" goes: the feed when it's on, otherwise the user's profile (which lists their posts). */
export function feedHome(): { path: string; label: string } {
  return isFeatureEnabled('socialFeed') ? { path: '/feed', label: t('social.back_to_feed') } : { path: '/profile', label: t('nav.yourProfile') };
}
