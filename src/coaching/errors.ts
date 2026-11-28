import { friendlyError } from '@/social/pendingPosts';
import { t } from '@/i18n';

/** Network-type failure (offline, fetch failed) — queued work should simply wait and retry. */
export function isNetworkError(e: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  return /failed to fetch|networkerror|network request failed|load failed|network error|timed? ?out/i.test(raw);
}

/** Short sentence a person can act on, for any coaching API error. */
export function coachingError(e: unknown, fallback = t('sync.genericError')): string {
  const raw = e instanceof Error ? e.message : '';
  if (/not implemented/i.test(raw)) return t('coaching.directory.coaching_unavailable_try_later');
  return friendlyError(e, fallback);
}
