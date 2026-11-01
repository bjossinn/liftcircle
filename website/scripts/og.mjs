// Renders public/og.png (1200×630) from the real brand icon, fonts and an app screenshot.
// Run with `npm run og` after changing the hero line; the PNG is committed.
import { chromium } from 'playwright';
import { writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { en as t } from '../src/content/en.ts';

const here = (p) => pathToFileURL(fileURLToPath(new URL(p, import.meta.url))).href;
const [a, b] = t.hero.title.split(', ');
const html = `<!doctype html><meta charset="utf-8"><style>
@font-face { font-family: B; font-weight: 700; src: url('${here('../public/fonts/barlow-semi-condensed-latin-700-normal.woff2')}'); }
@font-face { font-family: I; font-weight: 100 900; src: url('${here('../public/fonts/inter-latin-wght-normal.woff2')}'); }
* { margin: 0; box-sizing: border-box; }
body { width: 1200px; height: 630px; overflow: hidden; background: #17191B; color: #F3EFE7; font-family: I; position: relative; }
.noise { position: absolute; inset: 0; background: url('${here('../public/noise.svg')}'); opacity: .09; mix-blend-mode: overlay; }
.stripes { position: absolute; right: -40px; top: 0; width: 620px; height: 150px; opacity: .35; clip-path: polygon(18% 0,100% 0,100% 100%,0 100%);
  background: repeating-linear-gradient(-55deg, transparent 0 22px, rgb(255 105 79 / .55) 22px 26px); }
.brand { position: absolute; left: 72px; top: 64px; display: flex; align-items: center; gap: 16px; font: 700 34px/1 B; letter-spacing: .04em; }
.brand img { width: 56px; height: 56px; border-radius: 12px; }
h1 { position: absolute; left: 68px; top: 168px; font: 700 128px/.86 B; text-transform: uppercase; letter-spacing: -.015em; }
h1 span { display: block; } h1 .e { color: #FF694F; }
.phone { position: absolute; right: 92px; top: 70px; width: 300px; padding: 9px; border-radius: 42px; background: #0B0C0D; border: 1px solid #3D4448; rotate: 6deg;
  box-shadow: 0 40px 80px -20px rgb(0 0 0 / .8); }
.phone img { width: 100%; border-radius: 34px; display: block; }
.band { position: absolute; left: -20px; right: -20px; bottom: 34px; background: #FF694F; color: #17191B; border-block: 4px solid #17191B; rotate: -1.6deg;
  font: 700 38px/1 B; text-transform: uppercase; letter-spacing: .02em; white-space: nowrap; padding: 16px 0 13px 40px; }
</style>
<div class="noise"></div><div class="stripes"></div>
<div class="brand"><img src="${here('icon-1024.png')}" alt="">HARD EARNED</div>
<h1><span>${a},</span><span class="e">${b}</span></h1>
<div class="phone"><img src="${here('../src/assets/screens/dark-06-active-workout.png')}" alt=""></div>
<div class="band">${[...t.ticker, ...t.ticker].join(' · ')} ·</div>`;

const tmp = fileURLToPath(new URL('./.og.html', import.meta.url));
writeFileSync(tmp, html);
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto(pathToFileURL(tmp).href);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: fileURLToPath(new URL('../public/og.png', import.meta.url)) });
await browser.close();
rmSync(tmp);
console.log('public/og.png');
