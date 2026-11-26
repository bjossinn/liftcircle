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

/** Thrown when the send was cancelled (the chat closed, or the signed-in account changed). */
export class SendCancelled extends Error {
  readonly code = 'cancelled';
  constructor() {
    super('Cancelled.');
  }
}
export const isCancelled = (e: unknown) => e instanceof SendCancelled;

/** `signal`: cancels before the next attempt and during the wait between attempts (never sends after it fires). */
export async function sendWhileInProgress<T>(
  send: () => Promise<T>,
  opts: { delayMs?: number; attempts?: number; sleep?: (ms: number) => Promise<void>; signal?: AbortSignal } = {},
): Promise<T> {
  const attempts = opts.attempts ?? IN_PROGRESS_ATTEMPTS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      opts.signal?.removeEventListener('abort', done);
      resolve();
    }
    opts.signal?.addEventListener('abort', done);
  }));
  for (let i = 0; ; i++) {
    if (opts.signal?.aborted) throw new SendCancelled();
    try {
      return await send();
    } catch (e) {
      if (!isInProgress(e) || i >= attempts) throw e;
      await sleep(opts.delayMs ?? IN_PROGRESS_DELAY_MS);
    }
  }
}
