/**
 * Consent helpers shared by the training assistant (coach.ts) and coach push copy (../push/copy.ts). Kept in their own
 * small module so the push-send bundle doesn't pull in the chat pipeline.
 */
// @ts-ignore Deno requires the .ts extension; the app tsconfig does not enable allowImportingTsExtensions.
import type { ProviderId } from './provider.ts';

/** Consent is recorded per provider ("2026-10-29:openai"). Older versions without a suffix were given for Anthropic. */
export function consentProvider(version: string | null | undefined): ProviderId | null {
  if (!version) return null;
  const tail = version.includes(':') ? version.slice(version.lastIndexOf(':') + 1).toLowerCase() : 'anthropic';
  return tail === 'openai' || tail === 'anthropic' ? tail : null;
}

/** The provider this user agreed to; a consent recorded before versions existed counts as Anthropic. */
export function consentedProvider(s: { consentAt?: string | null; consentVersion?: string | null } | null | undefined): ProviderId | null {
  if (!s?.consentAt) return null;
  return consentProvider(s.consentVersion || '2026-10-29');
}
