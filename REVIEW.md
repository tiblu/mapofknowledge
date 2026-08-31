# Code Review — KnoBitz

## Architecture Overview

KnoBitz is an AI-assisted knowledge-map learning platform (Estonian-first, K-12). Users navigate a D3 force graph of ~10,000 curriculum nodes, then enter a guided learning flow for individual leaf concepts ("knobits"). All content is generated on demand by Claude.

### Runtime layers

```
Browser
  ├── Vanilla JS IIFEs — window.MapView, Learn, Test, Anne, Tour, Timeline, CM*
  ├── D3 v7 force graph (app.js)
  └── SSE streaming for LLM content

Express server (Node.js)
  ├── /auth  — Google OAuth + email/password (Passport)
  ├── /api   — 60+ routes across learning, profile, game, teacher, parent
  ├── /api/admin — super_admin only
  ├── /api/subsets — custom map management
  └── /app   — protected static file serving (requireAuth)

Services
  ├── llm.js          — all Anthropic SDK calls (~1,200 lines)
  ├── game.js         — lumens, ranks, momentum, achievements, streaks
  ├── notifications.js — in-app notifications + getUserLocale
  ├── mailer.js       — transactional email via Nodemailer
  └── _anthropicAlert.js — wraps client to catch billing failures

Database — MariaDB (mysql2 pool, no ORM, raw parameterised SQL)
  ├── Knowledge graph   — nodes, edges, node_translations
  ├── Learning state    — knobits, knobit_progress, knobit_interactions
  │                       knobit_translations, lootbox_cache
  ├── Learner Passport  — learner_passports, passport_*, user_node_knowledge
  ├── Gamification      — lumen_transactions, user_momentum, user_streaks,
  │                       user_achievements
  └── Social graph      — learner_links, teacher_groups, teacher_group_members
```

### Key data flows

**Starting a knobit:** `POST /api/nodes/:id/learn` → generate knobit list (Sonnet), translate titles (Haiku → Sonnet editor pass), attach progress + resume session → return to client. Content generation is lazy and cached in DB; re-entering the same node is cheap.

**Learning interaction:** `POST /api/learn/interact` → one of ~10 LLM call variants depending on `{phase, action}` → optionally second-pass language editor for non-English → save interaction → stream or JSON response.

**Knobit completion:** `POST /api/learn/knobit/:id/complete` → update progress → recompute node knowledge % → propagate to ancestors via recursive CTE walk → award lumens (with momentum multiplier) → check achievements → update streak → check goal completion.

---

## Strengths

### LLM integration is mature

- **Prompt caching is used everywhere.** Every system prompt has `cache_control: { type: 'ephemeral' }`, including the TUTOR_SYSTEM block reused across all explain/practice/meaning calls. This is production-grade cost management.
- **Fail-open throughout.** `editTranslatedText`, `moderateTags`, and `generateChildOrder` all have explicit fallback paths so an LLM hiccup never breaks content delivery.
- **JSON robustness.** `parseJSON` strips markdown fences; `_extractJSON` finds a JSON object in surrounding prose. Both are needed — Claude does emit markdown fences sometimes.
- **Streaming and non-streaming share one client code path.** `_fakeStreamText` paces pre-generated text through the SSE `write` callback so the frontend's chunk-rendering logic needs no branching.
- **SSE keepalive.** Apache buffers SSE; the 3-second `: ping` comment keeps the connection visible to the upstream proxy.
- **Two-pass translation (Haiku → Sonnet editor).** Haiku translates cheaply; a Sonnet Estonian-language editor fixes grammar without creative rewrites. The editor prompt is minimal and precise.

### Authorization is solid

- Every teacher/parent route validates the `learner_links` relationship in the database before returning any student data — no IDOR vectors found.
- Teacher routes additionally verify group ownership (`teacher_groups.teacher_user_id = ?`) before operating on members.
- Under-13 children cannot disconnect themselves from a parent link (age is DB-sourced, not client-trusted).
- Admin routes have a `requireSuperAdmin` guard applied router-wide, not per-route.

### SQL discipline

- All queries are fully parameterised. No string interpolation of user input into SQL found.
- Dynamic `IN (${ids.map(() => '?').join(',')})` clauses are built from typed arrays derived from previous queries (not user input), so the parameterisation is correct.
- Recursive CTEs used well: ancestor knowledge propagation and domain/breadcrumb lookups are clean.
- `ON DUPLICATE KEY UPDATE` and `INSERT IGNORE` make writes idempotent throughout.

### Thoughtful gamification

- Momentum multiplier (`user_momentum`) is time-based (hours since last activity) and separate from the calendar streak (`user_streaks`). These are two different, non-conflated concepts.
- `awardLumens` is awaited on the knobit-complete path specifically so the actual (multiplier-adjusted) amount can be shown in the UI. Branch bonuses run in parallel. Achievements run fire-and-forget — all the right choices.
- The loot box (`lootbox_cache`) is generated once per `(node, locale)` and shared across all learners, not regenerated per user.

### Frontend module boundaries

The IIFE pattern with explicit `/* Owns / Exposes / Calls / Never */` headers is enforced consistently. `MapView` never implements learning logic; `Learn` never touches map rendering. This discipline keeps 8,000+ lines of vanilla JS navigable.

### Operational resilience

- `_wrapWithBillingAlert` surfaces Anthropic credit exhaustion as admin notifications + email within one hour of the first failure, with a cooldown so simultaneous failures don't spam. This solved a real production incident (flagged in a code comment).
- `ecosystem.config.js` sets `autorestart: true` and `max_memory_restart`.
- Cookie-session (not memory-stored) survives server restarts without session invalidation.
- In-memory map cache per locale avoids re-querying 10k nodes on every page load.

---

## Prioritized Improvements

### 🔴 Critical — fix before next production deploy

**1. No startup validation of required environment variables**
The app starts silently with broken configuration. The worst case: `SESSION_SECRET` falls back to a hardcoded public string, making every session cookie forgeable. Add a guard at the top of `server/app.js` before any module loads:
```js
const REQUIRED_ENV = ['DB_HOST', 'DB_USER', 'DB_PASS', 'DB_NAME', 'ANTHROPIC_API_KEY', 'SESSION_SECRET'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) throw new Error(`Missing required env vars: ${missing.join(', ')}`);
```

**2. No rate limiting on LLM routes**
`/api/learn/interact`, `/api/test/question`, `/api/test/evaluate`, `/api/anne/message` make Anthropic API calls with no per-user throttle. A single user can exhaust the credit balance. Add `express-rate-limit` keyed on `req.user.id` to these routes.

**3. TESTLOG writing user data to disk in production**
19 `// TESTLOG` markers write full LLM prompts, user answers, and evaluation history to `server/testlog.txt`. This is live in production and was never removed. Delete `server/testlog.js` and remove all `// TESTLOG` callsites.

**4. Base database schema is missing from the repository**
`server/db/migrate.js` only performs additive `ALTER TABLE`/`CREATE TABLE IF NOT EXISTS` changes — it assumes the core tables (`nodes`, `edges`, `users`, `learner_passports`, `knobit_progress`, etc.) already exist. A fresh environment has no way to bootstrap the database from the repo alone. Export the schema from production (`mariadb-dump --no-data`) and commit it as `server/db/schema.sql`, then wire it into `migrate.js` to run before the additive steps.

---

### 🟠 Security

**6. No CSRF protection**
`cookie-session` is used without `sameSite`. All state-changing POST/DELETE routes are vulnerable to cross-site request forgery. Set `sameSite: 'lax'` on the session cookie — no token infrastructure required.

**7. No security headers**
No `helmet` middleware. Missing `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, and `Referrer-Policy`. Add `helmet()` as the first middleware in `server/app.js`.

**8. `SELECT *` from `users` in `deserializeUser`**
Attaches `password_hash`, `google_id`, and all other sensitive columns to `req.user` on every request. Select only the columns the session object actually needs.

**9. `/map/bust-cache` accessible to any authenticated user**
Any logged-in learner can clear the in-memory map cache for all locales. Restrict to admin role.

**10. Color field in teacher groups is unvalidated**
`req.body.color` is stored in the DB and rendered in the UI without validation. Add a `^#[0-9A-Fa-f]{6}$` check.

---

### 🟡 User Experience & Performance

**11. Knowledge map lags with 2,000+ visible nodes**
The map is SVG-based — every node is a live DOM element. `ticked()` fires at 60fps during simulation, writing ~25,000 DOM attributes per frame. Fixes in priority order:
- Switch the nodes/edges layer to Canvas rendering (highest impact)
- Stop the simulation once `alpha < 0.005`; pre-compute stable positions server-side
- Memoize `nodeFilterResult` within each `refreshNodeColors()` call (currently called 3× per node with unmemoized subtree walks)
- Move labels into the zoom group so they don't need manual repositioning on every pan/zoom event

**12. `getUserLocale` called 24+ times per request**
Each call issues a separate `SELECT` to `user_settings`. Store locale on `req.user` at session deserialization time — one DB read instead of dozens.

**13. `updateAncestorKnowledge` runs sequential DB round-trips on knobit completion**
For each ancestor (up to 5 levels) it runs two recursive CTEs sequentially. Can be batched or restructured into a single pass.

**14. Client-trusted `localDate` for streak calculation**
The client sends its local calendar date for streak tracking. A future date gives streak credit without studying. Validate within ±1 calendar day of server UTC time.

---

### 🔵 Reliability & Operations

**15. No migration history**
`server/db/migrate.js` has no record of what has been applied to a given database. Re-running it may fail silently or noisily depending on the state. Adopt **Knex** for migrations only — existing queries stay untouched, but roll-forward/rollback and a `knex_migrations` history table come for free. Knex also opens an incremental path to query-builder adoption and eventual Postgres support if needed.

**16. Empty array in dynamic `IN ()` produces a SQL syntax error**
`IN (${ids.map(() => '?').join(',')})` with an empty array generates `IN ()` which MariaDB rejects. Add a length guard before each callsite, or adopt Knex's `.whereIn()` which handles this automatically.

**17. No structured logging**
95 `console.log/error` calls with no request IDs, no log levels, no structured JSON. Debugging production issues requires guessing at timing. Replace with `pino` and a request-ID middleware.

**18. DB backup and restore strategy is unknown**
It is unclear whether Zone.ee provides automated backups for the MariaDB instance, at what frequency, and how long they are retained. Open questions: Does Zone.ee take daily snapshots? Is point-in-time recovery available? Has a restore ever been tested? What is the expected RTO/RPO? Verify in the Zone.ee control panel and document the answers. If automated backups are insufficient, add a nightly `mariadb-dump` cron job to an off-host location (e.g. S3-compatible storage).

---

### ⚪ Code Quality & Maintainability

**19. `api.js` is a 3,000-line monolith**
60+ routes across all domains in one file. Split into `routes/learn.js`, `routes/profile.js`, `routes/teacher.js`, `routes/parent.js`, `routes/game.js`, `routes/notifications.js`.

**20. No tests**
No test runner, no test files, no `npm test`. Any refactor carries full regression risk. The `/learn/interact` handler with its 10+ branches is the highest-risk area.

**21. No TypeScript**
No explicit contracts between modules, routes, or services. `req.user` is accessed with `?.` chaining 100+ times because its shape is never declared. LLM response shapes, route request bodies, and cross-module function signatures are all implicit. Adding TypeScript to the server is a bounded incremental change; the frontend requires a bundler and should be treated as a separate phase. Primary value: legibility and compile-time correctness for both humans and AI assistants working in the codebase.

**22. No frontend framework**
`learning.js` (2,175 lines) and the profile/teacher/parent pages are almost entirely imperative DOM manipulation managing a dozen pieces of state through scattered module-level variables. A reactive framework would eliminate the manual DOM synchronisation and roughly halve the line count. Recommended approach: islands architecture — keep D3 owning the map canvas, migrate everything else (learning overlay, sidebar, all other pages) to **Svelte** or **Vue 3**. Requires Vite as a bundler — the same infrastructure as frontend TypeScript, so these two should be done together.

| Framework | D3 coexistence | Learning curve | TS support | Ecosystem |
|---|---|---|---|---|
| **Svelte** | ★★★★★ | Low | Good | Small |
| **Vue 3** | ★★★★☆ | Low–medium | Good | Large |
| **React** | ★★☆☆☆ | Medium | Excellent | Largest |

**23. i18n is effectively binary**
`LANG_NAMES = { et: 'Estonian' }` plus implicit English. Adding a third language requires touching `LANG_NAMES`, `EDITOR_PROMPTS`, locale checks across route handlers, DB `locale` columns, and `strings.js`. Theoretically extensible but not practically pluggable.

---

## Summary Table

| Area | Rating | Notes |
|---|---|---|
| LLM integration | ★★★★★ | Prompt caching, fail-open, streaming, robust JSON parsing |
| Authorization | ★★★★☆ | Per-route relationship checks; missing CSRF |
| SQL safety | ★★★★☆ | Fully parameterised; `SELECT *` / empty-IN edge cases |
| Security hardening | ★★☆☆☆ | No Helmet, no CSRF, no rate limiting, private key in repo |
| Frontend architecture | ★★☆☆☆ | Clear module contracts; no framework, no bundler; imperative DOM at scale |
| Performance | ★★☆☆☆ | Good DB/LLM caching; SVG map lags with 2k+ nodes; getUserLocale N+1 |
| Observability | ★★☆☆☆ | No structured logging, TESTLOG in production |
| Testability | ★☆☆☆☆ | Zero tests |
| Code organisation | ★★★☆☆ | One 3,000-line route file; services are well-separated |