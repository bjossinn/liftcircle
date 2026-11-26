/**
 * Incremental server-sent-events parser for the training assistant stream (roadmap item 10). Pure, no DOM.
 *
 *  - Bytes in, events out: UTF-8 is decoded incrementally (a multi-byte letter such as "ð" or "þ" split across network
 *    chunks is joined, never replaced), frames are split on blank lines with LF, CRLF or CR line endings, several
 *    events in one chunk and one event over many chunks both work, and comment lines (": keep-alive") are heartbeats.
 *  - Bounded: a frame larger than `maxFrameChars` or a buffer that grows past it without a frame end is a protocol error.
 *  - `end()` at EOF: a trailing partial frame is discarded (never dispatched), and the caller decides what EOF without a
 *    terminal event means (interrupted / unconfirmed).
 */
export class SseProtocolError extends Error {
  readonly code = 'stream_protocol';
  constructor(readonly kind: 'oversized' | 'malformed') {
    super(`Malformed training assistant stream (${kind}).`);
    this.name = 'SseProtocolError';
  }
}

export interface SseRawEvent {
  event: string;
  data: string;
}

export const MAX_FRAME_CHARS = 512 * 1024;

export function createSseParser(opts: { onEvent: (e: SseRawEvent) => void; onHeartbeat?: () => void; maxFrameChars?: number }) {
  const max = opts.maxFrameChars ?? MAX_FRAME_CHARS;
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let event = '';
  let data: string[] = [];
  let frameChars = 0;
  let pendingCR = false;

  const dispatch = () => {
    if (data.length || event) opts.onEvent({ event: event || 'message', data: data.join('\n') });
    event = '';
    data = [];
    frameChars = 0;
  };
  const line = (l: string) => {
    if (l === '') return dispatch();
    frameChars += l.length + 1;
    if (frameChars > max) throw new SseProtocolError('oversized');
    if (l.startsWith(':')) return opts.onHeartbeat?.();
    const i = l.indexOf(':');
    const field = i < 0 ? l : l.slice(0, i);
    let value = i < 0 ? '' : l.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    // id / retry / unknown fields are ignored
  };
  const drain = () => {
    for (;;) {
      let idx = -1;
      for (let i = 0; i < buf.length; i++) {
        const c = buf[i];
        if (c === '\n' || c === '\r') {
          idx = i;
          break;
        }
      }
      if (idx < 0) break;
      const l = buf.slice(0, idx);
      const isCR = buf[idx] === '\r';
      buf = buf.slice(idx + 1);
      if (pendingCR && idx === 0 && !isCR) {
        // the LF of a CRLF pair that was split across chunks
        pendingCR = false;
        continue;
      }
      pendingCR = false;
      if (isCR) {
        if (buf.startsWith('\n')) buf = buf.slice(1);
        else if (buf === '') pendingCR = true;
      }
      line(l);
    }
    if (buf.length > max) throw new SseProtocolError('oversized');
  };
  return {
    push(chunk: Uint8Array | string) {
      buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      drain();
    },
    /** EOF: flush the decoder; an unfinished frame is dropped. */
    end() {
      buf += decoder.decode();
      drain();
      buf = '';
      event = '';
      data = [];
    },
  };
}
