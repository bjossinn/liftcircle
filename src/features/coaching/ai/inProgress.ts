/**
 * Replays of a message that is still being answered (1.0.3). The server reserves each message id while it answers; a
 * second send of the same id (app reloaded mid-answer, a retry tap, a second tab) gets 409 `in_progress` instead of a
 * second generation. The reply is then on its way, so the app waits and asks again with the SAME id: once the first
 * request has finished, the server returns the stored reply (`duplicate`). Bounded; after that the usual error shows
 * and Retry sends the same id again.
 */
export const IN_PROGRESS_DELAY_MS = 5000;
// ~3 min 10 s: longer than the server's answer budget AND its 3-minute reservation, so even an answer that died without
// releasing it (function killed) ends in a fresh start with the same id rather than an error.
export const IN_PROGRESS_ATTEMPTS = 38;

export const isInProgress = (e: unknown) => (e as { code?: unknown } | null)?.code === 'in_progress';

export async function sendWhileInProgress<T>(
  send: () => Promise<T>,
  opts: { delayMs?: number; attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = opts.attempts ?? IN_PROGRESS_ATTEMPTS;
  for (let i = 0; ; i++) {
    try {
      return await send();
    } catch (e) {
      if (!isInProgress(e) || i >= attempts) throw e;
      await sleep(opts.delayMs ?? IN_PROGRESS_DELAY_MS);
    }
  }
}
