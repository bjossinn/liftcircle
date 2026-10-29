// Generates PWA icons from an original SVG app mark. Run: npm run icons
import sharp from 'sharp';
import { writeFileSync, mkdirSync } from 'node:fs';

const BG = '#16191d';
const ACCENT = '#4fbf7f';
// The mark: an open green ring ("circle") with a barbell crossing it.
const mark = (pad) => `
  <g transform="translate(${pad} ${pad}) scale(${(512 - pad * 2) / 512})">
    <path d="M 386 140 A 170 170 0 1 0 410 300" fill="none" stroke="${ACCENT}" stroke-width="44" stroke-linecap="round"/>
    <rect x="120" y="243" width="272" height="26" rx="13" fill="#e8ece9"/>
    <rect x="150" y="196" width="34" height="120" rx="12" fill="#e8ece9"/>
    <rect x="328" y="196" width="34" height="120" rx="12" fill="#e8ece9"/>
    <rect x="112" y="216" width="26" height="80" rx="10" fill="#e8ece9"/>
    <rect x="374" y="216" width="26" height="80" rx="10" fill="#e8ece9"/>
  </g>`;
const svg = (pad, rounded) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" ${rounded ? 'rx="112"' : ''} fill="${BG}"/>${mark(pad)}</svg>`;

mkdirSync('public/icons', { recursive: true });
writeFileSync('public/icons/favicon.svg', svg(40, true));
const any = Buffer.from(svg(40, false));
const maskable = Buffer.from(svg(96, false)); // keep the mark inside the 80% safe zone
await sharp(any).resize(192, 192).png().toFile('public/icons/icon-192.png');
await sharp(any).resize(512, 512).png().toFile('public/icons/icon-512.png');
await sharp(maskable).resize(512, 512).png().toFile('public/icons/maskable-512.png');
await sharp(Buffer.from(svg(56, false))).resize(180, 180).png().toFile('public/icons/apple-touch-icon.png');
console.log('icons written');
