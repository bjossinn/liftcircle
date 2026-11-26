/**
 * Settings/Data error messages. Raw `Error.message` values from IndexedDB, Supabase or the network are not approved
 * copy (and may carry server payloads), so only known errors are mapped to their message; anything else gets the
 * supplied generic fallback.
 */
import { StorageWriteError } from '@/db/repo';
import { t, type MessageKey } from '@/i18n';
import { BackupValidationError } from './backupSchema';

export function knownErrorText(e: unknown, fallback: MessageKey = 'common.error'): string {
  if (e instanceof BackupValidationError) return e.message; // built from the dictionary
  if (e instanceof StorageWriteError) return t('sync.saveStorageFailed');
  return t(fallback);
}

/**
 * The message shown when a restore fails: a known error followed by "Nothing was changed." unless the message already
 * says so (typed by the error code, never by inspecting the text). Unknown errors use the complete fallback sentence.
 */
export function restoreErrorText(e: unknown): string {
  if (e instanceof BackupValidationError) return e.statesNothingChanged ? e.message : t('settings.restoreError', { error: e.message });
  if (e instanceof StorageWriteError) return t('settings.restoreError', { error: t('sync.saveStorageFailed') });
  return t('settings.backupImportFailed');
}
