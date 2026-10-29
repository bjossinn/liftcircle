// finalize-post — verifies a draft post's uploaded photos and publishes it.
//
// POST { postId } with the user's access token (Authorization: Bearer <jwt>).
//  1. verify the JWT and that the caller authored the post (service role reads, filtered by caller id)
//  2. for every post_media row: the image AND thumbnail objects exist, are within size limits,
//     are real JPEG/WebP files (magic bytes), carry no EXIF/APP1/XMP/IPTC (GPS) metadata and are
//     at most 4096 px (thumbnails 1024 px) per side
//  3. mark media ready + publish atomically via public.finalize_post_publish (service-role only RPC)
// Idempotent: calling it again for a published post returns { status: 'published' }.
import { handler, HttpError, json, readJson, UUID_RE } from '../_shared/http.ts';
import { adminClient, requireUser } from '../_shared/supabase.ts';
import { validateImage } from '../_shared/image.ts';

const BUCKET = 'post-media';
const IMAGE_LIMITS = { maxBytes: 5 * 1024 * 1024, maxSide: 4096 };
const THUMB_LIMITS = { maxBytes: 512 * 1024, maxSide: 1024 };

interface MediaRow {
  id: string;
  image_path: string;
  thumb_path: string;
  width: number;
  height: number;
}

Deno.serve(handler(async (req) => {
  const user = await requireUser(req);
  const { postId } = await readJson<{ postId?: string }>(req);
  if (!postId || !UUID_RE.test(postId)) throw new HttpError(400, 'A valid post id is required.');

  const admin = adminClient();
  const { data: post, error: postErr } = await admin
    .from('posts').select('id, author_id, status, deleted_at').eq('id', postId).maybeSingle();
  if (postErr) throw new Error(postErr.message);
  if (!post || post.author_id !== user.id) throw new HttpError(404, 'Post not found.');
  if (post.deleted_at) throw new HttpError(410, 'This post was deleted.');
  if (post.status === 'published') return json({ id: postId, status: 'published' });

  const { data: media, error: mediaErr } = await admin
    .from('post_media').select('id, image_path, thumb_path, width, height').eq('post_id', postId).order('position');
  if (mediaErr) throw new Error(mediaErr.message);

  const report: { id: string; width: number; height: number; bytes: number; thumb_bytes: number }[] = [];
  const problems: { mediaId: string; part: 'image' | 'thumb'; problem: string }[] = [];

  for (const m of (media ?? []) as MediaRow[]) {
    const sizes: Record<'image' | 'thumb', { bytes: number; width: number; height: number } | null> = { image: null, thumb: null };
    for (const part of ['image', 'thumb'] as const) {
      const path = part === 'image' ? m.image_path : m.thumb_path;
      const { data: blob, error } = await admin.storage.from(BUCKET).download(path);
      if (error || !blob) {
        problems.push({ mediaId: m.id, part, problem: 'not uploaded yet' });
        continue;
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const info = validateImage(bytes, part === 'image' ? IMAGE_LIMITS : THUMB_LIMITS);
      for (const p of info.problems) problems.push({ mediaId: m.id, part, problem: p });
      sizes[part] = { bytes: bytes.length, width: info.width, height: info.height };
    }
    if (sizes.image && sizes.thumb) {
      report.push({ id: m.id, width: sizes.image.width, height: sizes.image.height, bytes: sizes.image.bytes, thumb_bytes: sizes.thumb.bytes });
    }
  }

  if (problems.length) {
    const missing = problems.every((p) => p.problem === 'not uploaded yet');
    throw new HttpError(422, missing ? 'Some photos have not finished uploading.' : 'Some photos could not be accepted. Please re-select them and try again.', problems);
  }

  const { data, error } = await admin.rpc('finalize_post_publish', { p_post_id: postId, p_user_id: user.id, p_media: report });
  if (error) throw new HttpError(409, error.message);
  return json(data);
}));
