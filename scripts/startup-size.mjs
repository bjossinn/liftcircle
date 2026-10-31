// Startup bundle size: everything index.html loads before the first route chunk (entry script, modulepreloads,
// stylesheets), raw and gzipped. Usage: node scripts/startup-size.mjs [distDir]
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const dist = process.argv[2] ?? 'dist';
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const files = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
let raw = 0;
let gz = 0;
for (const f of [...new Set(files)]) {
  const buf = fs.readFileSync(path.join(dist, f));
  const z = gzipSync(buf).length;
  raw += buf.length;
  gz += z;
  console.log(`${f.padEnd(48)} ${(buf.length / 1024).toFixed(1).padStart(7)} KiB  ${(z / 1024).toFixed(1).padStart(6)} KiB gz`);
}
const fonts = fs.readdirSync(path.join(dist, 'assets')).filter((f) => /\.(woff2?|ttf)$/.test(f));
console.log(`${'TOTAL startup'.padEnd(48)} ${(raw / 1024).toFixed(1).padStart(7)} KiB  ${(gz / 1024).toFixed(1).padStart(6)} KiB gz`);
if (fonts.length) console.log(`fonts (loaded on demand, not at startup): ${fonts.map((f) => `${f} ${(fs.statSync(path.join(dist, 'assets', f)).size / 1024).toFixed(1)} KiB`).join(', ')}`);
