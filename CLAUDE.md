# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start server (development)
node server/index.js

# Start server (production via PM2)
pm2 start ecosystem.config.js

# Run database migrations (additive — safe to re-run)
node server/db/migrate.js
```

There is no build step, no test suite, and no linter configured. The server runs directly from source; frontend files are served as static assets.

## Architecture

**KnoBitz** is a D3-powered interactive knowledge map with an AI-assisted learning mode. It is an Estonian-first educational platform.

### Stack

- **Backend**: Node.js + Express, cookie-session (survives restarts), Passport (Google OAuth + email/password)
- **Frontend**: Vanilla JS (IIFE modules exposing `window.*` globals) + D3 v7 force graph, no bundler
- **Database**: MariaDB via `mysql2` connection pool (`server/db/index.js`), raw SQL throughout — no ORM
- **LLM**: Anthropic SDK (`@anthropic-ai/sdk`); model constants in `server/services/llm.js`: `HAIKU = 'claude-haiku-4-5'`, `SONNET = 'claude-sonnet-4-6'`

### Server layout

| Path | Purpose |
|---|---|
| `server/app.js` | Express app setup, route mounting, session |
| `server/index.js` | HTTP listen + hourly goal-reminder cron |
| `server/routes/api.js` | Main API (~3000 lines) — learning, progress, passport, game |
| `server/routes/auth.js` | Email/password + Google OAuth signup/login |
| `server/routes/admin.js` | Admin-only routes |
| `server/routes/subsets.js` | Custom map subset routes |
| `server/services/llm.js` | All Anthropic API calls (knobit generation, explanation, practice, etc.) |
| `server/services/game.js` | Lumens (XP), ranks, achievements, streaks |
| `server/services/notifications.js` | In-app notifications + `getUserLocale()` |
| `server/db/migrate.js` | Additive schema migration + initial JSON→DB seed |

Route protection: `requireAuth` middleware guards `/api/*` and `/app/*`. Public: `/auth/*`, `/signup`, root static files.

### Frontend layout

All frontend JS uses the IIFE pattern and exposes a single `window.Foo` global:

| File | Global | Owns |
|---|---|---|
| `app/js/app.js` | `window.MapView` | D3 force simulation, zoom/pan, node rendering, sidebar, filter state |
| `app/js/learning.js` | `window.Learn` | `#learning-mode` overlay, knobit flow (explain → demonstrate → practice → meaning) |
| `app/js/testing.js` | `window.Test` | Knowledge test UI (`#lm-test`) |
| `app/js/anne.js` | `window.Anne` | AI tutor chat sidebar |
| `app/js/timeline.js` | `window.Timeline` | Learning timeline view |
| `app/js/tour.js` | `window.Tour` | Onboarding tour |
| `app/js/custom-map-*.js` | `window.CMManual/CMReview/CMUpload` | Custom map creation |
| `app/js/strings.js` | `window.t(key)` | i18n string lookup |

Module boundaries are strict: `MapView` never implements learning; `Learn` never touches map rendering.

### Data model highlights

- **Nodes/edges**: stored in MariaDB `nodes` + `edges` tables, seeded from `app/knowledge_map.json` (foundational) and `app/knowledge_map_emergent.json` (emergent). Each node has an `external_id` (the original JSON id) used everywhere in the API.
- **Learner Passport**: `learner_passports` → credentials, competencies, `passport_tags` (interests/values), `passport_events`, `passport_relationships`, `passport_goals`, `knobit_progress`, `user_node_knowledge`
- **Game**: `user_streaks` (streak + streak-savers), lumens stored on `learner_passports.lumens`, achievements in `user_achievements`
- **LLM cache**: `lootbox_cache` — generated Loot Box content per `(node_external_id, locale)`, reused across learners

### i18n

- Default locale is `et` (Estonian). Users can switch via `user_settings` (`key_name = 'ui_locale'`).
- Backend: `getUserLocale(userId)` from `server/services/notifications.js`.
- Frontend: `t('key')` from `app/js/strings.js`, strings fetched from `/api/strings`. Static HTML uses `data-i18n="key"` attributes.
- Database-level translations for node labels: `node_translations` table, joined with `LEFT JOIN … locale = ?`.

### Notable patterns

- `server/testlog.js` is a temporary debug file logger. Search `// TESTLOG` to find all usages when removing it.
- The `_wrapWithBillingAlert` wrapper in `server/services/_anthropicAlert.js` wraps the Anthropic client to catch billing/rate errors globally.
- `cookie-session` does not provide `regenerate`/`save` methods required by Passport 0.7+; the shim in `server/app.js` adds them.
- LLM calls use `keepAlive: false` on the HTTPS agent to avoid mid-stream connection reuse failures against the Anthropic API.
- `server/db/migrate.js` doubles as the schema migration runner (additive `ALTER TABLE`/`CREATE TABLE IF NOT EXISTS`) and the one-time JSON seed. Re-running is safe; it skips seed if `nodes` is non-empty.

### Environment variables

Loaded from `.env` (one directory above `server/`). Required keys: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, `DB_NAME`, `SESSION_SECRET`, `ANTHROPIC_API_KEY`. Google OAuth needs `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`.