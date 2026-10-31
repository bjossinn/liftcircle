/**
 * Copies the approved Hard Earned launcher icons from the brand kit into public/icons/ (exact files, no resizing or
 * redrawing). Source: brand/hard-earned/assets/ (see asset-manifest.json there). Run: npm run icons
 */
import { copyFileSync } from 'node:fs';

const FILES = [
  'favicon-16.png',
  'favicon-32.png',
  'apple-touch-icon-180.png',
  'hard-earned-pwa-192.png',
  'hard-earned-pwa-512.png',
  'hard-earned-maskable-512.png'
];
for (const f of FILES) copyFileSync(`brand/hard-earned/assets/${f}`, `public/icons/${f}`);
console.log(`Copied ${FILES.length} icons to public/icons/`);
