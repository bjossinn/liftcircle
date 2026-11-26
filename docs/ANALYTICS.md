# Product analytics (roadmap item 5)

Privacy-first: a handful of allowlisted events tell us whether the app gets people training. Nothing else.

## Events

| Event | When | Properties |
| --- | --- | --- |
| `first_set_logged` | First working set ticked by an account with no finished workout that has a set yet (once per account) | none |
| `first_workout_completed` | The account's first finished workout (once) | none |
| `second_workout_within_7d` | The second finished workout ends within 7 days of the first (once) | none |
| `onboarding_completed` | Setup finished: suggested plan accepted or manual plan created (once) | `path`: `suggested` \| `manual` |
| `workout_started` | A new workout session was created | `source`: `template` \| `repeat` \| `empty` |
| `ai_action_used` | Training assistant actions | `action_type`: `chat_message` \| `checkin_review` \| `program_proposal` \| `week_plan` \| `meal_plan`; `outcome`: `sent` \| `proposed` \| `applied` \| `dismissed` \| `reverted` |

Accounts that already had workouts before this shipped never get a late "first" event: milestones are derived from
the local records and marked as done without being recorded.

## Privacy guarantees

- **Allowlist at the boundary** (`src/analytics/events.ts` → `sanitizeEvent`): unknown event names are dropped; only
  listed property keys survive, and only when the value is one of that key's enum strings. There is no numeric,
  free-text or nested property, so weights, reps, RPE/RIR, exercise names, body measurements, calories, protein,
  macros, injuries, discomfort, notes, chat messages/replies, names and email cannot be carried. Stored events are
  re-checked before sending.
- **Server enforces the same allowlist** (`public.log_product_events`, migration
  `supabase/migrations/20261127000001_product_analytics.sql`): the user comes from the access token, invalid items are
  skipped, at most 50 per call and 500 per user per day. The table has only `id, user_id, event_name, props,
  occurred_at, received_at`; clients have no grant on it (nobody can read events back through the API). RLS is on with
  an insert-own-only policy as defence in depth. Deleting the account deletes the events.
- **Opt-out**: Settings → Sharing & privacy → "Share product usage events" (`settings.analytics`, default on). Off:
  nothing is recorded and queued events are deleted, never sent.
- **Guest and demo mode record nothing** (no account to send for).

## Transport

Events queue in the account's local database (`kv` keys `analytics:queue`, `analytics:milestones`; at most 200
events) and are sent in batches by `AnalyticsRunner` (app shell) while signed in and online. If the migration isn't
applied yet, the server errors or the device is offline, events stay queued with backoff; nothing is shown to the
user and logging is never blocked.

## Tests

- `tests/unit/analytics.test.ts`: allowlist, client ↔ migration allowlist match, opt-out, guest/demo, milestones,
  queue bounds, transport gating/backoff, and an end-to-end "first week" check that no health data, chat text or PII
  reaches the queue or the wire.
- `npm run test:analytics-db` (`tests/rls/analytics-run.mjs`): grants/RLS, server allowlist, idempotency, limits,
  cascade delete.
