// finalize-coach-media — verifies the photos of a coaching chat message and marks it 'sent'.
//
// POST { messageId } with the user's access token.
//  1. verify the JWT; public.coach_media_pending (service-only RPC) confirms the caller SENT the message and
//     the conversation is still writable (active relationship, active coach, no block) — checked now, not
//     when the upload started
//  2. for every declared media id: image {rel}/{msg}/{id}.jpg AND thumbnail {…}_thumb.jpg exist in the private
//     `coach-media` bucket, are real JPEG/WebP (magic bytes), carry no EXIF/XMP/IPTC (GPS) metadata, and are
//     within size/pixel limits (shared validator with finalize-post)
//  3. public.finalize_coach_message (service-only RPC) flips the message to 'sent' with a fresh seq and
//     notifies the other participant (no message text in the notification)
// Idempotent: calling it again for a sent message returns { status: 'sent', already: true }.
import { handler, HttpError, json, readJson, UUID_RE } from '../_shared/http.ts';
import { adminClient, requireUser } from '../_shared/supabase.ts';
import { validateImage } from '../_shared/image.ts';

const BUCKET = 'coach-media';
const IMAGE_LIMITS = { maxBytes: 5 * 1024 * 1024, maxSide: 4096 };
const THUMB_LIMITS = { maxBytes: 512 * 1024, maxSide: 1024 };

interface PendingMessage {
  id: string;
  relationship_id: string;
  sender_id: string;
  status: 'awaiting_media' | 'sent';
  media: { id: string; width: number; height: number }[];
}

function rpcError(error: { message: string; code?: string }): HttpError {
  if (error.code === '42501') return new HttpError(403, error.message || 'This conversation is read-only now.');
  if (/not found/i.test(error.message)) return new HttpError(404, error.message);
  return new HttpError(409, error.message);
}

Deno.serve(handler(async (req) => {
  const user = await requireUser(req);
  const { messageId } = await readJson<{ messageId?: string }>(req);
  if (!messageId || !UUID_RE.test(messageId)) throw new HttpError(400, 'A valid message id is required.');

  const admin = adminClient();
  const pending = await admin.rpc('coach_media_pending', { p_message: messageId, p_user: user.id });
  if (pending.error) throw rpcError(pending.error);
  const msg = pending.data as PendingMessage;
  if (msg.status === 'sent') return json({ ...msg, already: true });

  const report: { id: string; width: number; height: number }[] = [];
  const problems: { mediaId: string; part: 'image' | 'thumb'; problem: string }[] = [];
  for (const m of msg.media ?? []) {
    let width = 0;
    let height = 0;
    let complete = true;
    for (const part of ['image', 'thumb'] as const) {
      const path = `${msg.relationship_id}/${msg.id}/${m.id}${part === 'thumb' ? '_thumb' : ''}.jpg`;
      const { data: blob, error } = await admin.storage.from(BUCKET).download(path);
      if (error || !blob) {
        problems.push({ mediaId: m.id, part, problem: 'not uploaded yet' });
        complete = false;
        continue;
      }
      const info = validateImage(new Uint8Array(await blob.arrayBuffer()), part === 'image' ? IMAGE_LIMITS : THUMB_LIMITS);
      for (const p of info.problems) problems.push({ mediaId: m.id, part, problem: p });
      if (part === 'image') {
        width = info.width;
        height = info.height;
      }
    }
    if (complete) report.push({ id: m.id, width, height });
  }
  if (problems.length) {
    const missing = problems.every((p) => p.problem === 'not uploaded yet');
    throw new HttpError(422, missing ? 'Some photos have not finished uploading.' : 'Some photos could not be accepted. Please re-select them and try again.', problems);
  }

  const done = await admin.rpc('finalize_coach_message', { p_message: messageId, p_user: user.id, p_media: report });
  if (done.error) throw rpcError(done.error);
  return json(done.data);
}));
