// Full-page screenshots for review: node scripts/shots.mjs [url] [outDir]
// Needs a running server (npm run preview). Uses the installed Chrome.
import { chromium } from 'playwright';
import sharp from 'sharp';

const url = process.argv[2] || 'http://localhost:4321/';
const out = process.argv[3] || 'docs';
const browser = await chromium.launch({ channel: 'chrome' });
for (const [name, width, height, mobile] of [['390', 390, 844, true], ['1440', 1440, 900, false]]) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.evaluate(() => Promise.all([...document.images].map((i) => { i.loading = 'eager'; return i.decode().catch(() => {}); })));
  // Reveal everything that animates in on scroll, then return to the top.
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 500) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); }
    document.querySelectorAll('[data-reveal]').forEach((el) => el.classList.add('in'));
    scrollTo(0, 0);
  });
  // Chrome repeats content past ~16k device pixels, so capture viewport-sized slices and stitch them.
  await page.addStyleTag({ content: '.site-header{position:relative!important}' });
  const total = await page.evaluate(() => document.documentElement.scrollHeight);
  const slices = [];
  for (let y = 0; y < total; y += height) {
    await page.evaluate((y) => scrollTo(0, y), y);
    await page.waitForTimeout(150);
    const top = await page.evaluate(() => scrollY);
    slices.push({ input: await page.screenshot(), top: top * (mobile ? 2 : 1), left: 0 });
  }
  const scale = mobile ? 2 : 1;
  await sharp({ create: { width: width * scale, height: total * scale, channels: 3, background: '#17191B' } })
    .composite(slices).png().toFile(`${out}/full-${name}.png`);
  console.log(`${out}/full-${name}.png`);
  await page.close();
}
await browser.close();
