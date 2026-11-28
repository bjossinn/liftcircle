// Renders docs/exercise-glyphs.html to docs/screenshots/exercise-glyphs.png (run `npm run glyphs:sheet` first).
import { chromium } from '@playwright/test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const html = resolve('docs/exercise-glyphs.html');
const out = resolve(process.argv[2] ?? 'docs/screenshots/exercise-glyphs.png');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: Number(process.env.DPR ?? 1) });
await page.goto(pathToFileURL(html).href);
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log(`wrote ${out}`);
