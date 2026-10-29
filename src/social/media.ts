/**
 * Client-side image pipeline for post photos and avatars.
 *
 * Every image is decoded (respecting EXIF orientation), downscaled and RE-ENCODED to JPEG
 * through a canvas. Re-encoding produces a brand-new file that carries none of the original
 * metadata (EXIF, GPS, XMP, maker notes). `hasExifOrGps()` is run on the output as a final assert.
 *
 * Pure helpers (sniffing, header dimension parsing, sizing, the JPEG segment scanner) have no DOM
 * dependency and are unit-tested.
 */

export const MAX_INPUT_BYTES = 25 * 1024 * 1024; // 25 MB
export const MAX_PIXELS = 50_000_000; // 50 MP
export const MAX_EDGE = 2048;
export const THUMB_EDGE = 480;
export const AVATAR_EDGE = 512;
export const JPEG_QUALITY = 0.85;
export const THUMB_QUALITY = 0.8;

export type ImageKind = 'jpeg' | 'png' | 'gif' | 'webp' | 'heic' | 'avif';
export type MediaErrorCode = 'too_large' | 'unsupported' | 'too_many_pixels' | 'decode_failed' | 'encode_failed' | 'metadata' | 'empty';

const MESSAGES: Record<MediaErrorCode, string> = {
  too_large: 'This photo is larger than 25 MB. Try a smaller one.',
  unsupported: 'This format isn’t supported on this device — try JPEG or PNG.',
  too_many_pixels: 'This photo is too large (over 50 megapixels). Try a smaller one.',
  decode_failed: 'This photo couldn’t be read. It may be damaged — try another one.',
  encode_failed: 'This photo couldn’t be prepared on this device. Try another one.',
  metadata: 'This photo couldn’t be cleaned of location data, so it wasn’t added.',
  empty: 'This file is empty.',
};

export class MediaError extends Error {
  readonly code: MediaErrorCode;
  constructor(code: MediaErrorCode) {
    super(MESSAGES[code]);
    this.name = 'MediaError';
    this.code = code;
  }
}

export interface ProcessedImage {
  /** EXIF-free JPEG, long edge ≤ MAX_EDGE. */
  blob: Blob;
  /** EXIF-free JPEG thumbnail, long edge ≤ THUMB_EDGE. */
  thumb: Blob;
  width: number;
  height: number;
}

/* ================================================================ pure helpers */

const ascii = (bytes: Uint8Array, start: number, len: number) => {
  let s = '';
  for (let i = start; i < start + len && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
};

const startsWithAscii = (bytes: Uint8Array, text: string, offset = 0) => {
  if (bytes.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  return true;
};

function containsAscii(bytes: Uint8Array, text: string): boolean {
  const n = text.length;
  outer: for (let i = 0; i + n <= bytes.length; i++) {
    for (let j = 0; j < n; j++) if (bytes[i + j] !== text.charCodeAt(j)) continue outer;
    return true;
  }
  return false;
}

const HEIF_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'];

/** Identify an image by its magic bytes (never trusts the file name or MIME type). */
export function sniffImageType(bytes: Uint8Array): ImageKind | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && startsWithAscii(bytes, 'PNG', 1) && bytes[4] === 0x0d && bytes[5] === 0x0a) return 'png';
  if (startsWithAscii(bytes, 'GIF87a') || startsWithAscii(bytes, 'GIF89a')) return 'gif';
  if (startsWithAscii(bytes, 'RIFF') && startsWithAscii(bytes, 'WEBP', 8)) return 'webp';
  if (startsWithAscii(bytes, 'ftyp', 4)) {
    const major = ascii(bytes, 8, 4);
    if (major === 'avif' || major === 'avis') return 'avif';
    if (HEIF_BRANDS.includes(major)) return 'heic';
    // Check compatible brands for files whose major brand is generic.
    const boxSize = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
    for (let o = 16; o + 4 <= Math.min(boxSize, bytes.length); o += 4) {
      const b = ascii(bytes, o, 4);
      if (b === 'avif') return 'avif';
      if (HEIF_BRANDS.includes(b)) return 'heic';
    }
  }
  return null;
}

/** Fall back to the declared MIME type only for HEIC/HEIF (some pickers hand over odd containers). */
export function detectKind(bytes: Uint8Array, mimeType: string): ImageKind | null {
  const sniffed = sniffImageType(bytes);
  if (sniffed) return sniffed;
  if (/^image\/hei[cf]/i.test(mimeType)) return 'heic';
  return null;
}

/**
 * Read pixel dimensions from the file header without decoding, so oversized images are
 * rejected before a decode can exhaust memory. Returns null if not determinable from `bytes`.
 */
export function readImageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const kind = sniffImageType(bytes);
  const be16 = (o: number) => (bytes[o] << 8) | bytes[o + 1];
  const le16 = (o: number) => bytes[o] | (bytes[o + 1] << 8);
  const le24 = (o: number) => bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16);
  const be32 = (o: number) => ((bytes[o] << 24) >>> 0) + ((bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]);
  switch (kind) {
    case 'png':
      if (bytes.length < 24 || !startsWithAscii(bytes, 'IHDR', 12)) return null;
      return { width: be32(16), height: be32(20) };
    case 'gif':
      if (bytes.length < 10) return null;
      return { width: le16(6), height: le16(8) };
    case 'webp': {
      if (bytes.length < 30) return null;
      const chunk = ascii(bytes, 12, 4);
      if (chunk === 'VP8X') return { width: le24(24) + 1, height: le24(27) + 1 };
      if (chunk === 'VP8L') {
        const b0 = bytes[21], b1 = bytes[22], b2 = bytes[23], b3 = bytes[24];
        return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
      }
      if (chunk === 'VP8 ') return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
      return null;
    }
    case 'jpeg': {
      let i = 2;
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) return null;
        const m = bytes[i + 1];
        if (m === 0xff) {
          i++;
          continue;
        }
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
          i += 2;
          continue;
        }
        if (m === 0xd9 || m === 0xda) return null;
        const len = be16(i + 2);
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          return { height: be16(i + 5), width: be16(i + 7) };
        }
        if (len < 2) return null;
        i += 2 + len;
      }
      return null;
    }
    default:
      return null;
  }
}

/** Scale (w,h) so the long edge is at most `maxEdge`; never upscales. */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= maxEdge) return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  const s = maxEdge / long;
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

/** Validate size/type/pixels before decoding. Throws MediaError. Returns the detected kind. */
export function checkInput(file: { size: number; type: string }, head: Uint8Array, limits = { maxBytes: MAX_INPUT_BYTES, maxPixels: MAX_PIXELS }): ImageKind {
  if (file.size === 0) throw new MediaError('empty');
  if (file.size > limits.maxBytes) throw new MediaError('too_large');
  const kind = detectKind(head, file.type);
  if (!kind) throw new MediaError('unsupported');
  const dims = readImageDimensions(head);
  if (dims && dims.width * dims.height > limits.maxPixels) throw new MediaError('too_many_pixels');
  return kind;
}

/**
 * Scan JPEG marker segments up to the start of scan and report whether any metadata segment that
 * can carry personal/location data is present: APP1 Exif, APP1 XMP, APP13 Photoshop/IPTC, or any
 * APPn segment mentioning "GPS". Fails safe: a malformed/truncated header returns true because
 * it cannot be proven clean. Non-JPEG input returns false (it has no JPEG segments to scan).
 */
export function hasExifOrGps(bytes: Uint8Array): boolean {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let i = 2;
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) return true; // malformed
    const m = bytes[i + 1];
    if (m === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (m === 0xda || m === 0xd9) return false; // start of scan / end of image: header is clean
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2; // standalone marker
      continue;
    }
    if (i + 3 >= bytes.length) return true;
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2 || i + 2 + len > bytes.length) return true; // truncated
    const seg = bytes.subarray(i + 4, i + 2 + len);
    if (m === 0xe1 && (startsWithAscii(seg, 'Exif\0') || startsWithAscii(seg, 'http://ns.adobe.com/xap/1.0/'))) return true;
    if (m === 0xed && startsWithAscii(seg, 'Photoshop 3.0')) return true;
    if (m >= 0xe0 && m <= 0xef && containsAscii(seg, 'GPS')) return true;
    i += 2 + len;
  }
  return true; // never reached a scan: cannot prove clean
}

/* ============================================================ browser pipeline */

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
}

async function readHead(file: Blob, n = 512 * 1024): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, n).arrayBuffer());
}

async function decode(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      /* fall through to <img> */
    }
  }
  if (typeof document === 'undefined') throw new MediaError('decode_failed');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    // Modern browsers apply EXIF orientation to <img> by default (image-orientation: from-image).
    await (img.decode ? img.decode() : new Promise<void>((res, rej) => ((img.onload = () => res()), (img.onerror = () => rej(new Error('decode'))))));
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('decode');
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
  } catch {
    throw new MediaError('decode_failed');
  } finally {
    URL.revokeObjectURL(url);
  }
}

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function makeCanvas(w: number, h: number): { canvas: AnyCanvas; ctx: Ctx2D } {
  let canvas: AnyCanvas;
  if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(w, h);
  else if (typeof document !== 'undefined') {
    canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
  } else throw new MediaError('encode_failed');
  const ctx = canvas.getContext('2d') as Ctx2D | null;
  if (!ctx) throw new MediaError('encode_failed');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return { canvas, ctx };
}

async function encodeJpeg(canvas: AnyCanvas, quality: number): Promise<Blob> {
  let blob: Blob | null = null;
  try {
    if ('convertToBlob' in canvas) blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    else blob = await new Promise<Blob | null>((res) => (canvas as HTMLCanvasElement).toBlob(res, 'image/jpeg', quality));
  } catch {
    throw new MediaError('encode_failed');
  }
  if (!blob || blob.type !== 'image/jpeg' || blob.size === 0) throw new MediaError('encode_failed');
  return blob;
}

/**
 * Draw `src` (crop rect sx,sy,sw,sh) into a w×h JPEG-ready canvas, halving in steps for large
 * reductions to avoid aliasing. Background is filled white so transparency doesn't turn black.
 */
function render(src: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, w: number, h: number): AnyCanvas {
  let cur: CanvasImageSource = src;
  let cx = sx, cy = sy, cw = sw, ch = sh;
  while (cw / 2 >= w * 1.0001 && ch / 2 >= h) {
    const nw = Math.max(w, Math.round(cw / 2));
    const nh = Math.max(h, Math.round(ch / 2));
    const step = makeCanvas(nw, nh);
    step.ctx.drawImage(cur, cx, cy, cw, ch, 0, 0, nw, nh);
    cur = step.canvas as CanvasImageSource;
    cx = 0;
    cy = 0;
    cw = nw;
    ch = nh;
  }
  const out = makeCanvas(w, h);
  out.ctx.fillStyle = '#ffffff';
  out.ctx.fillRect(0, 0, w, h);
  out.ctx.drawImage(cur, cx, cy, cw, ch, 0, 0, w, h);
  return out.canvas;
}

async function assertClean(blob: Blob): Promise<void> {
  const head = new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer());
  if (sniffImageType(head) !== 'jpeg' || hasExifOrGps(head)) throw new MediaError('metadata');
}

async function decodeChecked(file: Blob & { type: string }): Promise<{ decoded: Decoded; kind: ImageKind }> {
  const head = await readHead(file);
  const kind = checkInput(file, head);
  let decoded: Decoded;
  try {
    decoded = await decode(file);
  } catch (e) {
    // HEIC/AVIF decode support varies by browser: explain it as a format problem.
    if (kind === 'heic' || kind === 'avif') throw new MediaError('unsupported');
    throw e instanceof MediaError ? e : new MediaError('decode_failed');
  }
  if (decoded.width * decoded.height > MAX_PIXELS) {
    decoded.close();
    throw new MediaError('too_many_pixels');
  }
  return { decoded, kind };
}

/** Process a post photo: ≤ 2048 px JPEG + ≤ 480 px thumbnail, both metadata-free. */
export async function processImage(file: Blob, opts: { maxEdge?: number; thumbEdge?: number; quality?: number } = {}): Promise<ProcessedImage> {
  const { decoded } = await decodeChecked(file);
  try {
    const main = fitWithin(decoded.width, decoded.height, opts.maxEdge ?? MAX_EDGE);
    const mainCanvas = render(decoded.source, 0, 0, decoded.width, decoded.height, main.width, main.height);
    const blob = await encodeJpeg(mainCanvas, opts.quality ?? JPEG_QUALITY);
    const t = fitWithin(main.width, main.height, opts.thumbEdge ?? THUMB_EDGE);
    const thumbCanvas = render(mainCanvas as CanvasImageSource, 0, 0, main.width, main.height, t.width, t.height);
    const thumb = await encodeJpeg(thumbCanvas, THUMB_QUALITY);
    await assertClean(blob);
    await assertClean(thumb);
    return { blob, thumb, width: main.width, height: main.height };
  } finally {
    decoded.close();
  }
}

/** Process an avatar: centre-cropped square, ≤ 512 px, metadata-free JPEG. */
export async function processAvatar(file: Blob): Promise<Blob> {
  const { decoded } = await decodeChecked(file);
  try {
    const side = Math.min(decoded.width, decoded.height);
    const sx = Math.round((decoded.width - side) / 2);
    const sy = Math.round((decoded.height - side) / 2);
    const out = Math.min(AVATAR_EDGE, side);
    const canvas = render(decoded.source, sx, sy, side, side, out, out);
    const blob = await encodeJpeg(canvas, JPEG_QUALITY);
    await assertClean(blob);
    return blob;
  } finally {
    decoded.close();
  }
}

/** User-readable message for any error thrown by the pipeline. */
export function mediaErrorMessage(e: unknown): string {
  return e instanceof MediaError ? e.message : MESSAGES.decode_failed;
}
