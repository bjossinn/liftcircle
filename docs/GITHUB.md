# GitHub workflow (from v0.3.0)

The code lives in a private GitHub repo. Changes arrive as pull requests; **merging to `main` deploys**:

| What | Deployed by | When |
|---|---|---|
| Site (`src/`, `public/`, …) | Netlify's GitHub integration (`netlify.toml`: `npm ci && npm run build`, publish `dist`) | every push to `main`; pull requests get a Deploy Preview link |
| Database migrations | `.github/workflows/deploy-supabase.yml` → `supabase db push` | push to `main` touching `supabase/migrations/**` |
| Edge Functions | same workflow → `supabase functions deploy` (JWT setting from `supabase/config.toml`) | push to `main` touching `supabase/functions/**` or `config.toml` |
| Checks (typecheck, unit tests, build) | `.github/workflows/ci.yml` | every pull request and push |

`supabase db push` only applies migration files that aren't recorded in `supabase_migrations.schema_migrations`, so
migrations already applied by hand (including `deploy/2026-10-30_migrations.sql`) are skipped, never re-run.

## One-time setup (owner)

1. **Netlify:** Site configuration → Build & deploy → Link repository → GitHub → the `bjossinn/liftcircle` repo, branch `main`.
   Then Environment variables: `VITE_SUPABASE_URL = https://haryomdlsgrgrnsbdxui.supabase.co` and
   `VITE_SUPABASE_ANON_KEY = <the publishable key>`. Both are public client settings.
2. **GitHub repo secrets** (Settings → Secrets and variables → Actions → New repository secret):
   - `SUPABASE_ACCESS_TOKEN`: create at https://supabase.com/dashboard/account/tokens
   - `SUPABASE_DB_URL`: Supabase dashboard → **Connect** → *Session pooler* URI, with your database password filled
     in (Database settings → Reset password if you don't have it).
3. Optional: Settings → Environments → `production` → *Required reviewers* = you, so every backend deploy waits for
   a click even after merging.

Secrets are only typed into GitHub/Netlify by the owner; they are never committed.

## Local equivalents

`npm run typecheck && npx vitest run && npm run test:all` (needs PostgreSQL 16 and Playwright browsers) runs the full
suite before a pull request is opened.
