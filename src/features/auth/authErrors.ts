/**
 * Auth errors → one translated sentence. Supabase Auth returns stable error codes (`error.code`, or `error_code` in a
 * redirect URL) plus English prose; the prose is never shown. Known codes (and the older message shapes for servers
 * that don't send codes yet) map to dictionary keys; anything else gets a localized generic message.
 */
import { t, type MessageKey } from '@/i18n';

const BY_CODE: Record<string, MessageKey> = {
  otp_expired: 'auth.error.linkExpired',
  flow_state_expired: 'auth.error.linkExpired',
  flow_state_not_found: 'auth.error.linkExpired',
  bad_code_verifier: 'auth.error.linkExpired',
  bad_oauth_state: 'auth.error.linkExpired',
  same_password: 'auth.error.samePassword',
  weak_password: 'auth.error.weakPassword',
  invalid_credentials: 'auth.wrongCredentials',
  email_not_confirmed: 'auth.confirmEmailFirst',
  over_request_rate_limit: 'auth.tooManyAttempts',
  over_email_send_rate_limit: 'auth.tooManyAttempts',
  over_sms_send_rate_limit: 'auth.tooManyAttempts',
  user_already_exists: 'auth.error.emailInUse',
  email_exists: 'auth.error.emailInUse',
  signup_disabled: 'auth.error.signupDisabled',
  email_provider_disabled: 'auth.error.signupDisabled',
  session_expired: 'auth.error.sessionExpired',
  session_not_found: 'auth.error.sessionExpired',
  refresh_token_not_found: 'auth.error.sessionExpired',
  refresh_token_already_used: 'auth.error.sessionExpired',
  email_address_invalid: 'auth.invalidEmail',
  access_denied: 'auth.error.accessDenied',
};

const BY_MESSAGE: [RegExp, MessageKey][] = [
  [/invalid login|invalid credentials/i, 'auth.wrongCredentials'],
  [/not confirmed/i, 'auth.confirmEmailFirst'],
  [/rate limit|too many/i, 'auth.tooManyAttempts'],
  [/should be different from the old/i, 'auth.error.samePassword'],
  [/password should|weak password/i, 'auth.error.weakPassword'],
  [/expired|invalid.*(link|token|code)|(link|token|code).*invalid/i, 'auth.error.linkExpired'],
  [/already registered|already exists/i, 'auth.error.emailInUse'],
  [/failed to fetch|network ?error|network request failed|load failed/i, 'auth.error.network'],
];

export interface AuthErrorLike {
  code?: string | null;
  message?: string | null;
  status?: number;
}

/** Translated message for an auth error object, a redirect's `error_code` / `error_description`, or unknown input. */
export function authErrorMessage(err: AuthErrorLike | string | null | undefined, fallback: MessageKey = 'auth.error.unknown'): string {
  const e: AuthErrorLike = typeof err === 'string' ? { message: err } : (err ?? {});
  const code = e.code?.trim();
  if (code && BY_CODE[code]) return t(BY_CODE[code]);
  if (e.status === 429) return t('auth.tooManyAttempts');
  const msg = e.message ?? '';
  for (const [re, key] of BY_MESSAGE) if (re.test(msg)) return t(key);
  return t(fallback);
}

/** Error carried by an auth redirect (`?error=…&error_code=…&error_description=…`, query or hash), or null. */
export function authRedirectError(search: URLSearchParams, hash = typeof location !== 'undefined' ? location.hash : ''): string | null {
  const h = new URLSearchParams(hash.replace(/^#/, ''));
  const code = search.get('error_code') ?? h.get('error_code');
  const error = search.get('error') ?? h.get('error');
  const description = search.get('error_description') ?? h.get('error_description');
  if (!code && !error && !description) return null;
  // `error=access_denied` with `error_code=otp_expired` is an expired email link: the specific code wins.
  return authErrorMessage({ code: code ?? error, message: description }, 'auth.linkInvalid');
}
