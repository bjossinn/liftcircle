// Regenerates docs/exercise-glyphs.html from the live glyph code (cross-platform; sets UPDATE_GLYPH_SHEET for the test).
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const vitest = resolve('node_modules/vitest/vitest.mjs');
const r = spawnSync(process.execPath, [vitest, 'run', 'tests/unit/exerciseGlyphs.test.tsx'], {
  stdio: 'inherit',
  env: { ...process.env, UPDATE_GLYPH_SHEET: '1' },
});
process.exit(r.status ?? 1);
