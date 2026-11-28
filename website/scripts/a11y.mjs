// Runs axe-core (WCAG 2.2 A/AA rules, including colour contrast) on the built page at phone and desktop sizes,
// with every scroll-reveal shown and each install tab and FAQ answer opened. Needs `npm run preview`.
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

const url = process.argv[2] || 'http://localhost:4321/';
const browser = await chromium.launch({ channel: 'chrome' });
let failed = 0;
for (const width of [390, 1440]) {
  for (const motion of ['no-preference', 'reduce']) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: motion });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.evaluate(() => {
      document.querySelectorAll('[data-reveal]').forEach((el) => el.classList.add('in'));
      document.querySelectorAll('details').forEach((d) => (d.open = true));
    });
    await page.waitForTimeout(600);
    for (const tab of await page.locator('[role="tab"]').all()) {
      await tab.click();
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
      const label = `${width}px, motion ${motion}, tab "${await tab.textContent()}"`;
      if (r.violations.length) {
        failed++;
        console.log(`✗ ${label}`);
        for (const v of r.violations) console.log(`  ${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.slice(0, 4).map((n) => n.target.join(' ') + ' ' + (n.failureSummary || '').split('\n').slice(1, 2).join('')).join('\n    ')}`);
      } else console.log(`✓ ${label}: ${r.passes.length} rules passed, 0 violations`);
    }
    await ctx.close();
  }
}
await browser.close();
process.exit(failed ? 1 : 0);
