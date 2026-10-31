/* Mechanical export only. No retouching, recolouring, cropping or mark repositioning.
   Usage: node export-icons.cjs [kit-root] [approved-source.png] [qa-sheet.png]
   Requires Sharp; supports the supplied runtime's module location. */
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
let sharp;
try { sharp = require('sharp'); }
catch (error) {
  if (!process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES) throw error;
  sharp = require(path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'sharp'));
}

const kitRoot = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const assetsDir = path.join(kitRoot, 'assets');
const archivePath = path.join(assetsDir, 'source', 'hard-earned-approved-master.png');
const sourcePath = path.resolve(process.argv[3] || archivePath);
const qaPath = process.argv[4] ? path.resolve(process.argv[4]) : null;

const exportsSpec = [
  ['hard-earned-icon-1024.png', 1024, false, 'Opaque 1024px master / store submission source', 'master'],
  ['hard-earned-play-store-512.png', 512, true, 'Play Store high-resolution icon; opaque RGBA', 'play-store'],
  ['hard-earned-pwa-512.png', 512, false, 'PWA icon, purpose any', 'pwa-any'],
  ['hard-earned-pwa-192.png', 192, false, 'PWA icon, purpose any', 'pwa-any'],
  ['hard-earned-maskable-512.png', 512, false, 'PWA maskable icon; off-white mark within central safe circle', 'pwa-maskable'],
  ['apple-touch-icon-180.png', 180, false, 'Apple touch web icon', 'apple-touch'],
  ['favicon-32.png', 32, false, 'Browser favicon PNG, 32px', 'favicon'],
  ['favicon-16.png', 16, false, 'Browser favicon PNG, 16px', 'favicon'],
];

function sha(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }

function essentialMark(raw, info) {
  const { width, height, channels } = info;
  let pixels = 0, radiusCentre = 0, radiusCorner = 0;
  const bbox = [width, height, -1, -1];
  let extreme = null;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const rgb = [raw[i], raw[i + 1], raw[i + 2]];
      // Conservative achromatic bright mask: includes the dumbbell's antialiased
      // neutral edges while excluding the dark field and saturated ember corner.
      if (Math.min(...rgb) >= 60 && Math.max(...rgb) - Math.min(...rgb) <= 50) {
        pixels++;
        bbox[0] = Math.min(bbox[0], x); bbox[1] = Math.min(bbox[1], y);
        bbox[2] = Math.max(bbox[2], x); bbox[3] = Math.max(bbox[3], y);
        const centreDistance = Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2);
        const dx = Math.max(Math.abs(x - width / 2), Math.abs(x + 1 - width / 2));
        const dy = Math.max(Math.abs(y - height / 2), Math.abs(y + 1 - height / 2));
        const cornerDistance = Math.hypot(dx, dy);
        radiusCentre = Math.max(radiusCentre, centreDistance);
        if (cornerDistance > radiusCorner) { radiusCorner = cornerDistance; extreme = { x, y, rgb }; }
      }
    }
  }
  const safeRadius = 0.4 * Math.min(width, height);
  return {
    method: 'Bright neutral pixel mask: min(R,G,B)>=60 and max(R,G,B)-min(R,G,B)<=50; detects essential off-white dumbbell including neutral antialiasing; excludes saturated orange decorative corner.',
    essential_pixel_count: pixels,
    essential_bbox_inclusive: bbox,
    maximum_pixel_centre_radius_px: radiusCentre,
    conservative_pixel_corner_radius_px: radiusCorner,
    conservative_radius_fraction_of_side: radiusCorner / width,
    safe_circle_radius_px: safeRadius,
    conservative_margin_px: safeRadius - radiusCorner,
    passes_safe_circle: pixels > 0 && radiusCorner <= safeRadius,
    extreme_pixel: extreme,
    decorative_accent_policy: 'The orange upper-right corner is nonessential and may be clipped by launcher masks. The off-white dumbbell remains the recognisable mark.',
  };
}

async function inspect(file, spec) {
  const bytes = await fs.readFile(file);
  const metadata = await sharp(bytes).metadata();
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let alphaMin = 255, alphaMax = 0, edgeAlphaMin = 255;
  let edgeRGBMin = 255, edgeRGBMax = 0, edgePixels = 0, lightEdgePixels = 0;
  const darkEdgeCounts = { top: 0, bottom: 0, left: 0, right: 0 };
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      const a = data[i + 3];
      alphaMin = Math.min(alphaMin, a); alphaMax = Math.max(alphaMax, a);
      if (x === 0 || y === 0 || x === info.width - 1 || y === info.height - 1) {
        edgePixels++;
        edgeAlphaMin = Math.min(edgeAlphaMin, a);
        for (let c = 0; c < 3; c++) {
          edgeRGBMin = Math.min(edgeRGBMin, data[i + c]);
          edgeRGBMax = Math.max(edgeRGBMax, data[i + c]);
        }
        const rgb = [data[i], data[i + 1], data[i + 2]];
        if (Math.min(...rgb) >= 180 && Math.max(...rgb) - Math.min(...rgb) <= 50) lightEdgePixels++;
        if (Math.max(...rgb) < 80) {
          if (y === 0) darkEdgeCounts.top++;
          if (y === info.height - 1) darkEdgeCounts.bottom++;
          if (x === 0) darkEdgeCounts.left++;
          if (x === info.width - 1) darkEdgeCounts.right++;
        }
      }
    }
  }
  const entry = {
    file: 'assets/' + spec[0], role: spec[3], category: spec[4],
    width: metadata.width, height: metadata.height,
    format: metadata.format, colorspace: metadata.space,
    png_mode: metadata.hasAlpha ? 'RGBA' : 'RGB', bit_depth: bytes[24], png_color_type: bytes[25],
    icc_profile: { present: !!metadata.icc, bytes: metadata.icc ? metadata.icc.length : 0, target: 'sRGB' },
    alpha: { channel_present: !!metadata.hasAlpha, all_pixels_opaque: alphaMin === 255 && alphaMax === 255, min: alphaMin, max: alphaMax },
    physical_bytes: bytes.length, sha256: sha(bytes),
    full_bleed: { all_edge_pixels_opaque: edgeAlphaMin === 255, edge_pixels_checked: edgePixels, edge_rgb_min: edgeRGBMin, edge_rgb_max: edgeRGBMax, light_edge_pixels: lightEdgePixels, no_light_frame: lightEdgePixels === 0, dark_field_pixels_by_edge: darkEdgeCounts, dark_field_present_on_all_four_edges: Object.values(darkEdgeCounts).every(n => n > 0) },
  };
  if (entry.width !== spec[1] || entry.height !== spec[1]) throw Error('Wrong dimensions: ' + spec[0]);
  if (entry.alpha.channel_present !== spec[2]) throw Error('Wrong PNG alpha mode: ' + spec[0]);
  if (entry.colorspace !== 'srgb' || !entry.icc_profile.present) throw Error('Missing sRGB conversion/profile: ' + spec[0]);
  if (!entry.alpha.all_pixels_opaque || !entry.full_bleed.no_light_frame || !entry.full_bleed.dark_field_present_on_all_four_edges) throw Error('Opacity/full-bleed failure: ' + spec[0]);
  if (spec[4] === 'play-store') {
    entry.byte_limit = 1024 * 1024;
    entry.below_1024_KiB = bytes.length < entry.byte_limit;
    if (!entry.below_1024_KiB) throw Error('Play Store file exceeds limit');
  }
  if (spec[4] === 'pwa-maskable') {
    entry.maskable_safe_zone = essentialMark(data, info);
    if (!entry.maskable_safe_zone.passes_safe_circle) {
      await fs.unlink(file);
      throw Error('Maskable output did not pass. The source/master has not been modified.');
    }
  }
  return entry;
}

async function contactSheet() {
  const width = 1040, height = 580, cellW = 260, cellH = 290;
  const labels = ['1024 master', 'Play Store 512', 'PWA 512', 'PWA 192', 'Maskable / circle preview', 'Apple touch 180', 'Favicon 32 / native size', 'Favicon 16 / native size'];
  let text = '';
  const layers = [];
  for (let i = 0; i < exportsSpec.length; i++) {
    const spec = exportsSpec[i];
    const col = i % 4, row = Math.floor(i / 4);
    const size = Math.min(spec[1], 192);
    let png = await sharp(path.join(assetsDir, spec[0])).resize(size, size).png().toBuffer();
    if (spec[4] === 'pwa-maskable') {
      const circle = Buffer.from(`<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="white"/></svg>`);
      png = await sharp(png).ensureAlpha().composite([{ input: circle, blend: 'dest-in' }]).png().toBuffer();
    }
    layers.push({ input: png, left: Math.round(col * cellW + (cellW - size) / 2), top: row * cellH + 30 + Math.round((192 - size) / 2) });
    text += `<text x="${col * cellW + cellW / 2}" y="${row * cellH + 248}" text-anchor="middle" font-family="sans-serif" font-size="15" fill="#17191B">${labels[i]}</text>`;
  }
  layers.push({ input: Buffer.from(`<svg width="${width}" height="${height}">${text}<text x="20" y="574" font-family="sans-serif" font-size="12" fill="#50595E">QA only: assets remain full-bleed squares. Circular mask demonstrates optional clipping of the nonessential ember corner.</text></svg>`), left: 0, top: 0 });
  await sharp({ create: { width, height, channels: 3, background: '#F3EFE7' } }).composite(layers).png().toFile(qaPath);
}

async function main() {
  const sourceBytes = await fs.readFile(sourcePath);
  const originalMetadata = await sharp(sourceBytes).metadata();
  if (originalMetadata.width !== originalMetadata.height) throw Error('Source is not square; no crop is authorized.');
  const sourceRaw = await sharp(sourceBytes).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const sourceSafeZone = essentialMark(sourceRaw.data, sourceRaw.info);
  if (!sourceSafeZone.passes_safe_circle) throw Error('Source essential mark fails safe circle. No exports or source modification performed.');
  await fs.mkdir(path.dirname(archivePath), { recursive: true });
  if (sourcePath !== path.resolve(archivePath)) await fs.copyFile(sourcePath, archivePath);

  const items = [];
  for (const spec of exportsSpec) {
    let pipeline = sharp(sourceBytes).resize(spec[1], spec[1], { fit: 'fill', kernel: 'lanczos3' }).toColourspace('srgb').removeAlpha();
    if (spec[2]) pipeline = pipeline.ensureAlpha(1);
    await pipeline.withIccProfile('srgb').png({ palette: false, compressionLevel: 9, adaptiveFiltering: true }).toFile(path.join(assetsDir, spec[0]));
    items.push(await inspect(path.join(assetsDir, spec[0]), spec));
  }
  const manifest = {
    brand: 'Hard Earned', generated_date: '2026-10-31',
    operation: 'Mechanical proportional Lanczos3 resizing, sRGB conversion/profile embedding and requested RGB/RGBA channel encoding only. No crop, artwork repaint, repositioning or creative modification.',
    exporter: { sharp: sharp.versions.sharp, libvips: sharp.versions.vips },
    source: { file: 'assets/source/hard-earned-approved-master.png', width: originalMetadata.width, height: originalMetadata.height, native_mode: originalMetadata.hasAlpha ? 'RGBA' : 'RGB', icc_present: !!originalMetadata.icc, color_interpretation: originalMetadata.icc ? 'Uses embedded input profile' : 'Untagged RGB source interpreted as sRGB', physical_bytes: sourceBytes.length, sha256: sha(sourceBytes), preserved_byte_for_byte: true, safe_zone: sourceSafeZone },
    exports: items,
    native_adaptive_layers_caveat: 'These are flattened raster exports. The maskable web icon is not a native Android adaptive-icon foreground/background layer set or a themed monochrome layer; create those separate native assets if required by the target implementation. The Apple touch PNG is a web icon, not a complete native iOS asset catalog.',
    maskable_policy: 'Only the off-white dumbbell is essential. The orange decorative corner may be clipped by platform masks. Safe-circle verification uses a 40%-of-side radius and a conservative pixel-corner bound.',
    qa_note: 'All export edge pixels are opaque, the dark field remains visible on all four edges, and no transparent padding, baked app-tile rounding or light frame was added. At 16px, normal Lanczos downsampling mixes a little orange into two right-edge pixels; this is preserved rather than retouched.',
  };
  await fs.writeFile(path.join(assetsDir, 'asset-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  if (qaPath) { await fs.mkdir(path.dirname(qaPath), { recursive: true }); await contactSheet(); }
  console.log(JSON.stringify({ exported: items.map(x => ({ file: x.file, size: x.width, mode: x.png_mode, bytes: x.physical_bytes })), maskable: items.find(x => x.category === 'pwa-maskable').maskable_safe_zone, manifest: path.join(assetsDir, 'asset-manifest.json'), qa: qaPath }, null, 2));
}
main().catch(e => { console.error(e.stack || String(e)); process.exitCode = 1; });
