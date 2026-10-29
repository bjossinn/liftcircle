import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

/** Live tests against a real Supabase project: npm run test:live (see tests/connected). */
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { environment: 'node', include: ['tests/connected/**/*.test.ts'], testTimeout: 30_000, fileParallelism: false },
});
