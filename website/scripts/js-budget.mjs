// Fails if the built JavaScript is over 50 KB gzipped. Run after `npm run build`.
import { readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const dir = new URL('../dist/_astro/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
const total = files.reduce((n, f) => n + gzipSync(readFileSync(new URL(f, dir))).length, 0);
console.log(`JS: ${files.length} file(s), ${(total / 1024).toFixed(1)} KB gzipped (budget 50 KB)`);
if (total > 50 * 1024) process.exit(1);
