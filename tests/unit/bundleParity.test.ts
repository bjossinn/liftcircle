/**
 * Source/bundle parity: every single-file bundle in supabase/functions-bundled/ (pasted into the dashboard editor for
 * manual deploys, docs/BACKEND.md) is exactly what esbuild produces from supabase/functions/<name>/index.ts today.
 * Regenerate with the command in docs/BACKEND.md when a function or a _shared file changes.
 */
import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';

const ROOT = decodeURIComponent(new URL('../..', import.meta.url).pathname);
const FUNCTIONS = ['finalize-post', 'delete-account', 'cleanup-media', 'ai-coach', 'geocode', 'finalize-coach-media', 'push-send'];
const BUNDLED = import.meta.glob('../../supabase/functions-bundled/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const ENTRIES = Object.keys(import.meta.glob('../../supabase/functions/*/index.ts'));

describe('supabase/functions-bundled parity', () => {
  it('bundles exist for every function', () => {
    const dirs = ENTRIES.map((p) => p.split('/').at(-2)!);
    expect(dirs.sort()).toEqual([...FUNCTIONS].sort());
    expect(Object.keys(BUNDLED).map((p) => p.split('/').at(-1)!.replace(/\.ts$/, '')).sort()).toEqual([...FUNCTIONS].sort());
  });

  for (const fn of FUNCTIONS) {
    it(`${fn}.ts matches its sources`, async () => {
      const out = await build({
        absWorkingDir: ROOT,
        entryPoints: [`supabase/functions/${fn}/index.ts`],
        bundle: true,
        format: 'esm',
        platform: 'neutral',
        target: 'es2022',
        external: ['npm:*', 'jsr:*'],
        outfile: `supabase/functions-bundled/${fn}.ts`,
        write: false,
        logLevel: 'silent',
      });
      const fresh = out.outputFiles[0].text;
      const committed = BUNDLED[`../../supabase/functions-bundled/${fn}.ts`];
      expect(fresh === committed, `${fn}: bundle is stale — regenerate supabase/functions-bundled/${fn}.ts`).toBe(true);
    }, 30_000);
  }
});
