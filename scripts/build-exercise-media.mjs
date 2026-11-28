#!/usr/bin/env node
/**
 * Builds the self-hosted exercise illustrations in public/exercise-media/ from a local checkout of the
 * Everkinetic open data set (CC BY-SA 4.0, https://github.com/everkinetic/data). See docs/THIRD_PARTY_MEDIA.md.
 *
 *   git clone --depth 1 https://github.com/everkinetic/data.git /tmp/everkinetic
 *   node scripts/build-exercise-media.mjs /tmp/everkinetic
 *
 * Only the illustrations referenced by src/data/exerciseMedia.json are converted. Each source PNG (black line art on
 * white) becomes a transparent WebP: the lines are black and the alpha channel carries the line darkness, so the app can
 * show them on any theme surface (the dark theme inverts them to light lines with a CSS filter).
 *
 * Output per illustration: 0.webp (start frame, "relaxation"), 1.webp (end frame, "tension"), both at most 480 px on the
 * long side, and thumb.webp (end frame, 96 px) for the workout logger. Re-running is deterministic.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = process.argv[2];
if (!srcRoot || !fs.existsSync(path.join(srcRoot, 'dist/png'))) {
  console.error('Usage: node scripts/build-exercise-media.mjs <path to an everkinetic/data checkout>');
  process.exit(1);
}

const MEDIA_VERSION = 'v1';
const outRoot = path.join(root, 'public/exercise-media', MEDIA_VERSION);
const mapping = JSON.parse(fs.readFileSync(path.join(root, 'src/data/exerciseMedia.json'), 'utf8')).exercises;
const FRAME_MAX = 480;
const THUMB = 96;
const BUDGET = 40 * 1024;

/** Black line art on white → black RGBA with alpha = darkness, trimmed and padded to a square-ish box. */
async function toLineArt(file, size) {
  const { data, info } = await sharp(file)
    .flatten({ background: '#ffffff' })
    .grayscale()
    .trim({ background: '#ffffff', threshold: 10 })
    .resize(size, size, { fit: 'contain', background: '#ffffff', kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const px = info.width * info.height;
  const rgba = Buffer.alloc(px * 4);
  for (let i = 0; i < px; i++) {
    const g = data[i * info.channels];
    rgba[i * 4 + 3] = 255 - g; // RGB stays 0 (black)
  }
  return sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } });
}

const sources = new Map();
for (const [id, m] of Object.entries(mapping)) {
  if (m.source !== 'everkinetic') throw new Error(`${id}: unknown source ${m.source}`);
  sources.set(`${m.source === 'everkinetic' ? 'ek' : m.source}-${m.sourceId}`, m.sourceId);
}

fs.rmSync(outRoot, { recursive: true, force: true });
let total = 0;
const over = [];
for (const [dir, sourceId] of [...sources].sort()) {
  const outDir = path.join(outRoot, dir);
  fs.mkdirSync(outDir, { recursive: true });
  const frames = ['relaxation', 'tension'].map((f) => path.join(srcRoot, 'dist/png', `${sourceId}-${f}.png`));
  for (const f of frames) if (!fs.existsSync(f)) throw new Error(`Missing source image ${f}`);
  for (const [i, f] of frames.entries()) {
    const out = path.join(outDir, `${i}.webp`);
    await (await toLineArt(f, FRAME_MAX)).webp({ quality: 80, alphaQuality: 80, effort: 6, smartSubsample: true }).toFile(out);
    const size = fs.statSync(out).size;
    total += size;
    if (size > BUDGET) over.push(`${dir}/${i}.webp ${size}`);
  }
  const thumb = path.join(outDir, 'thumb.webp');
  await (await toLineArt(frames[1], THUMB)).webp({ quality: 80, alphaQuality: 80, effort: 6 }).toFile(thumb);
  total += fs.statSync(thumb).size;
}
console.log(`${sources.size} illustrations, ${Object.keys(mapping).length} exercises, ${(total / 1024).toFixed(1)} KB total`);
if (over.length) console.log(`Over the ${BUDGET / 1024} KB budget:\n  ${over.join('\n  ')}`);
