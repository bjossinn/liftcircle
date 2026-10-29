// Minimal, dependency-free image header inspection used by finalize-post.
// Verifies magic bytes, reads pixel dimensions and detects metadata segments that can carry
// camera/location data (JPEG APP1 = EXIF/XMP incl. GPS IFD, APP13 = IPTC/Photoshop;
// WebP EXIF/XMP chunks). The client strips metadata by re-encoding through a canvas; this is the
// server-side check that it actually happened.

export type ImageFormat = 'jpeg' | 'webp';

export interface ImageInfo {
  format: ImageFormat | null;
  width: number;
  height: number;
  /** Human-readable reasons the image is not acceptable (empty = OK). */
  problems: string[];
}

export function inspectImage(b: Uint8Array): ImageInfo {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return inspectJpeg(b);
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return inspectWebp(b);
  return { format: null, width: 0, height: 0, problems: ['not a JPEG or WebP image'] };
}

function ascii(b: Uint8Array, at: number, n: number): string {
  let s = '';
  for (let i = at; i < at + n && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function inspectJpeg(b: Uint8Array): ImageInfo {
  const info: ImageInfo = { format: 'jpeg', width: 0, height: 0, problems: [] };
  let i = 2;
  let scanned = false;
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) {
      if (scanned) {
        // entropy-coded data: skip ahead to the next marker (0xFF not followed by 0x00/RSTn)
        i++;
        continue;
      }
      info.problems.push('corrupt JPEG marker structure');
      break;
    }
    let m = b[i + 1];
    while (m === 0xff && i + 2 < b.length) {
      i++;
      m = b[i + 1];
    }
    if (m === 0x00 || (m >= 0xd0 && m <= 0xd7) || m === 0x01 || m === 0xd8) {
      i += 2; // stuffed byte / restart / TEM / SOI: no length
      continue;
    }
    if (m === 0xd9) break; // EOI
    if (i + 3 >= b.length) {
      info.problems.push('truncated JPEG');
      break;
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) {
      info.problems.push('truncated JPEG segment');
      break;
    }
    if (m === 0xe1) {
      const tag = ascii(b, i + 4, 6);
      info.problems.push(tag.startsWith('Exif') ? 'contains EXIF metadata (may include GPS location)' : 'contains APP1 (XMP) metadata');
    } else if (m === 0xed) {
      info.problems.push('contains IPTC/Photoshop metadata');
    } else if (SOF.has(m) && !info.width) {
      info.height = (b[i + 5] << 8) | b[i + 6];
      info.width = (b[i + 7] << 8) | b[i + 8];
    } else if (m === 0xda) {
      scanned = true; // start of scan; keep walking so metadata hidden after the scan is caught too
    }
    i += 2 + len;
  }
  if (!info.width || !info.height) info.problems.push('could not read JPEG dimensions');
  return info;
}

function inspectWebp(b: Uint8Array): ImageInfo {
  const info: ImageInfo = { format: 'webp', width: 0, height: 0, problems: [] };
  let i = 12;
  while (i + 8 <= b.length) {
    const fourcc = ascii(b, i, 4);
    const size = b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | (b[i + 7] << 24);
    const d = i + 8;
    if (size < 0 || d + size > b.length) {
      info.problems.push('truncated WebP chunk');
      break;
    }
    if (fourcc === 'VP8X') {
      const flags = b[d];
      if (flags & 0x08) info.problems.push('contains EXIF metadata (may include GPS location)');
      if (flags & 0x04) info.problems.push('contains XMP metadata');
      if (flags & 0x02) info.problems.push('animated images are not supported');
      info.width = 1 + (b[d + 4] | (b[d + 5] << 8) | (b[d + 6] << 16));
      info.height = 1 + (b[d + 7] | (b[d + 8] << 8) | (b[d + 9] << 16));
    } else if (fourcc === 'VP8 ' && !info.width) {
      if (b[d + 3] === 0x9d && b[d + 4] === 0x01 && b[d + 5] === 0x2a) {
        info.width = (b[d + 6] | (b[d + 7] << 8)) & 0x3fff;
        info.height = (b[d + 8] | (b[d + 9] << 8)) & 0x3fff;
      }
    } else if (fourcc === 'VP8L' && !info.width) {
      if (b[d] === 0x2f) {
        const bits = b[d + 1] | (b[d + 2] << 8) | (b[d + 3] << 16) | (b[d + 4] << 24);
        info.width = (bits & 0x3fff) + 1;
        info.height = ((bits >>> 14) & 0x3fff) + 1;
      }
    } else if (fourcc === 'EXIF') {
      if (!info.problems.some((p) => p.includes('EXIF'))) info.problems.push('contains EXIF metadata (may include GPS location)');
    } else if (fourcc === 'XMP ') {
      if (!info.problems.some((p) => p.includes('XMP'))) info.problems.push('contains XMP metadata');
    }
    i = d + size + (size & 1); // chunks are padded to even size
  }
  if (!info.width || !info.height) info.problems.push('could not read WebP dimensions');
  return info;
}

/** Checks one stored object against size and pixel limits. */
export function validateImage(bytes: Uint8Array, limits: { maxBytes: number; maxSide: number }): ImageInfo {
  const info = inspectImage(bytes);
  if (bytes.length === 0) info.problems.push('empty file');
  if (bytes.length > limits.maxBytes) info.problems.push(`file is larger than ${Math.round(limits.maxBytes / 1024)} KB`);
  if (info.width > limits.maxSide || info.height > limits.maxSide) {
    info.problems.push(`image is larger than ${limits.maxSide} px on a side`);
  }
  return info;
}
