// Records the hero "log a set" demo as docs/hero-demo.gif (and .webp) with a fake clock, so the frames
// are evenly timed. Needs `npm run preview`.
import { chromium } from 'playwright';
import sharp from 'sharp';

const url = process.argv[2] || 'http://localhost:4321/';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await page.clock.install();
await page.goto(url, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
const demo = page.locator('#demo');
const box = await demo.boundingBox();
const clip = { x: box.x - 40, y: box.y - 40, width: box.width + 80, height: box.height + 80 };
const frames = [];
const STEP = 80;
for (let t = 0; t < 9400; t += STEP) {
  await page.clock.runFor(STEP);
  frames.push(await page.screenshot({ clip }));
}
await browser.close();
const imgs = await Promise.all(frames.map((f) => sharp(f).resize({ width: 480 }).raw().toBuffer({ resolveWithObject: true })));
const { width, height, channels } = imgs[0].info;
const strip = Buffer.concat(imgs.map((i) => i.data));
const opts = { pageHeight: height, delay: Array(imgs.length).fill(STEP), loop: 0 };
await sharp(strip, { raw: { width, height: height * imgs.length, channels, pageHeight: height } }).gif({ ...opts, effort: 7 }).toFile('docs/hero-demo.gif');
await sharp(strip, { raw: { width, height: height * imgs.length, channels, pageHeight: height } }).webp({ ...opts, quality: 80 }).toFile('docs/hero-demo.webp');
console.log(`docs/hero-demo.gif, docs/hero-demo.webp: ${imgs.length} frames, ${width}×${height}`);
