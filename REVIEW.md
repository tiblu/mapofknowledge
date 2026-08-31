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

## Weaknesses

### 1. `api.js` is a 3,000-line monolith

Sixty-plus routes covering learning, profile editing, gamification, teacher dashboards, parent dashboards, notification management, admin token analytics, and recommendations all live in one file. This makes grepping, PR review, and onboarding significantly harder than it needs to be. Suggested split: `routes/learn.js`, `routes/profile.js`, `routes/teacher.js`, `routes/parent.js`, `routes/game.js`, `routes/notifications.js`.

### 2. No tests

There is no test runner, no test files, and no `npm test` script. The `testlog.js` file is a temporary debug logger, not a test harness. Any refactor carries full regression risk. The learning interaction path (`/learn/interact`) with its 10+ branches is the highest-risk area.

### 3. No rate limiting on LLM routes

`/api/learn/interact`, `/api/test/question`, `/api/test/evaluate`, `/api/anne/message`, and `/api/nodes/:id/suggest` all make Anthropic API calls. There is no per-user throttle. A single authenticated user could exhaust the Anthropic credit balance by hammering these endpoints. `express-rate-limit` applied per `req.user.id` would address this.

### 4. `getUserLocale` is called 24+ times per request cycle

`getUserLocale(req.user?.id)` issues a `SELECT` to `user_settings` on every call. In routes that call it multiple times (and in services called from routes that already fetched it), the same row is read from DB repeatedly. The locale should be fetched once and threaded through, or stored on `req.user` at session deserialization time.

### 5. `updateAncestorKnowledge` is O(depth × width) with sequential DB round-trips

On knobit completion, this function walks up the ancestor tree (up to 5 levels), and for each ancestor runs two recursive CTEs. The queries run sequentially inside a `for` loop. For a deeply nested node with many L5 descendants, this can be 10+ DB round-trips on the completion hot path. This is fire-and-forget (`.catch(() => {})`), which hides any slowness from the user but still loads the DB.

### 6. TESTLOG markers in production code

There are 19 `// TESTLOG` markers writing full LLM prompts, user answers, and evaluation data to `server/testlog.txt`. This is explicitly marked "temporary" but is actively running in production. The logged data includes `userAnswer` and full evaluation history. It should either be converted to structured debug logging or removed.

### 7. No security headers (no Helmet)

There is no `helmet` middleware or equivalent. The app is missing `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, `Strict-Transport-Security`, and `Referrer-Policy` headers. Since Apache terminates TLS, HSTS should be set at the Apache level, but the other headers are still missing.

### 8. No CSRF protection

`cookie-session` is used without `sameSite: 'strict'` or `'lax'`. All state-changing `POST`/`DELETE` routes are vulnerable to cross-site request forgery. Setting `sameSite: 'lax'` on the session cookie would mitigate the most common CSRF vectors without requiring token infrastructure.

### 9. `SELECT *` from `users` in `deserializeUser`

```js
const [rows] = await db.execute('SELECT * FROM users WHERE id = ?', [id]);
```

This attaches `password_hash`, `google_id`, and other sensitive columns to `req.user` on every authenticated request. `/auth/me` then manually whitelists the fields returned to the client. If a developer adds a new sensitive column and forgets to exclude it from `/auth/me`, it leaks. Select only the columns the session object needs.

### 10. Client-trusted `localDate` for streak calculation

```js
const localDate = req.body?.localDate;
```

The streak system relies on the client sending its local calendar date. A user sending a future date gets credit for that future day. Since streaks reset if no activity is recorded for the day, this lets users manipulate their streak without studying. The value should be validated to be within ±1 calendar day of the server UTC time.

### 11. No startup validation of required environment variables

The app starts silently even when critical configuration is missing. The worst case is `SESSION_SECRET`:

```js
secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
```

If that variable is absent from the production environment, every session cookie can be forged by anyone who has read this source. But the same silent-failure risk applies to the full set of required variables: `DB_HOST`, `DB_USER`, `DB_PASS`, `DB_NAME`, `ANTHROPIC_API_KEY`, `SESSION_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. Missing any of them produces hard-to-diagnose runtime failures long after the process has started — a DB pool that silently connects to nothing, or LLM calls that fail only when a user triggers them.

The fix is a single guard block at the top of `server/app.js`, before any module is required:

```js
const REQUIRED_ENV = [
  'DB_HOST', 'DB_USER', 'DB_PASS', 'DB_NAME',
  'ANTHROPIC_API_KEY', 'SESSION_SECRET',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) throw new Error(`Missing required env vars: ${missing.join(', ')}`);
```

A startup crash with a clear message is far preferable to a running process that is broken in non-obvious ways.

### 12. `/map/bust-cache` is accessible to any authenticated user

The route that clears the in-memory map cache for all locales requires only that the user is logged in. Any learner can call it. It should require admin role or be an internal/deployment-triggered mechanism.

### 13. Color field in teacher groups is unvalidated

```js
const color = (req.body.color || '#8BAD7E').trim();
```

This value is stored in the DB and rendered in the UI. No hex-color validation means arbitrary strings (including CSS injection vectors) can be stored. A simple `^#[0-9A-Fa-f]{6}$` check would close this.

### 13. Empty array in dynamic `IN ()` would malform the query

The pattern `IN (${ids.map(() => '?').join(',')})` appears four times. If `ids` is empty, the resulting SQL is `IN ()`, which is a syntax error in MariaDB. The callers all check length before calling, but this is a latent bug if that guard is ever missed.

### 14. No structured logging

95 `console.error` / `console.log` calls with no request IDs, no log levels, no structured JSON. In production (PM2 log files), correlating a user complaint to a specific failed request requires guessing at timing. A lightweight logger like `pino` with request ID middleware would dramatically improve observability.

### 15. i18n is effectively binary

`LANG_NAMES = { et: 'Estonian (Eesti keel)' }` plus implicit English. Adding a third language would require touching `LANG_NAMES`, `EDITOR_PROMPTS`, locale checks in multiple route handlers, the DB `locale` columns, and the frontend `strings.js` loader. The architecture is theoretically extensible but not practically pluggable.

### 16. Knowledge map rendering is SVG-based and lags with 2,000+ nodes

The map is rendered in SVG (not canvas), meaning every visible node, edge, and label is a live DOM element. The initial visible set is all L1–L4 nodes — likely 2,000–3,000 elements — each with event listeners, attribute writes on every simulation tick, and on every zoom/pan event. Several specific patterns compound the problem:

**Tick cost.** `ticked()` fires on every simulation step (~60fps while the simulation is warm) and writes 4 attributes on every edge, 2 on every node circle, and then calls `repositionLabels()` which computes and writes 2 attributes (x, y) on every visible label. With 3,000 visible nodes this is ~25,000 DOM attribute writes per frame.

**Labels are in a separate SVG.** Rather than living inside the zoomed `<g>` and getting the transform for free, labels are in a parallel `#label-layer` SVG that sits outside the zoom group. This means `repositionLabels()` must call `currentTransform.applyX/Y(d.x)` for every label on every tick *and* on every zoom/pan event — both paths call it.

**`nodeFilterResult` is called 3× per node per `refreshNodeColors()`.** The `fill`, `fill-opacity`, and `pointer-events` attribute setters each call `nodeFilterResult(d.id)` independently, and each call may recurse into `hasDescendantInLabelSet()` which walks the full subtree with no memoization. A single `refreshNodeColors()` call with a filter active can evaluate thousands of subtree walks.

**The force simulation never fully stops.** With `alphaDecay: 0.06` (moderate preset), the simulation runs for many seconds. During that entire window the tick callback is firing at 60fps. A user who changes settings, opens a sidebar, or applies a filter while the simulation is still warm gets both simulation ticks and DOM updates simultaneously.

**Proposed fixes, roughly in bang-for-buck order:**

1. **Switch to Canvas rendering.** Move the D3 simulation to headless (no DOM) and draw nodes/edges manually in a `requestAnimationFrame` loop onto a `<canvas>`. This reduces the rendering cost of 3,000 nodes from thousands of DOM writes to a single `ctx.fill()` per node per frame. Labels can remain in SVG as a thin overlay. This is the single highest-impact change.

2. **Stop the simulation once it settles.** Call `sim.stop()` when `sim.alpha() < 0.005`. Restart only when nodes are added (expand/collapse). Once positions are stable the tick callback should not be running at all.

3. **Pre-compute and cache node positions.** Run the force layout once (server-side or in a build step), store the stable `{x, y}` for each node, and seed those on page load. The simulation then only needs a handful of ticks to settle rather than several seconds, eliminating almost all frame-rate pressure at startup.

4. **Memoize `nodeFilterResult` per `refreshNodeColors()` call.** One `Map` built at the start of each call eliminates the repeated `hasDescendantInLabelSet` subtree walks: `const cache = new Map(); const result = (id) => { if (!cache.has(id)) cache.set(id, _nodeFilterResult(id)); return cache.get(id); };`

5. **Move labels into the zoom group.** If labels live inside `<g>` (the transformed group), they inherit the zoom transform automatically and `repositionLabels()` only needs to fire during tick (when node positions change), not on every zoom/pan.

6. **Cull off-screen labels.** `repositionLabels()` processes all visible labels. Skipping any label whose computed screen position falls outside `[0, w] × [0, h]` would reduce the DOM write count proportional to how much of the map is off-screen.

### 17. No migration history

`server/db/migrate.js` doubles as a one-time schema migration runner and the initial JSON-to-DB seed. There is no record of which changes have been applied to any given database instance. Some `ALTER TABLE` statements are guarded with `ADD COLUMN IF NOT EXISTS`, but others are not, and there is no way to determine the current schema version from outside the code. In practice this means:

- Re-running the file on a production database may silently skip some changes and fail noisily on others
- There is no rollback path for any schema change
- New team members or new deployments have no way to bring a blank database to the current schema incrementally

The recommended fix is to adopt **Knex** for migrations only, without changing any existing queries. Knex provides:

- `knex migrate:latest` — roll forward
- `knex migrate:rollback` — roll back the last batch
- `knex migrate:make <name>` — scaffolds a new timestamped migration file
- A `knex_migrations` table that records what has been applied and when

Migrations are plain JS files using `knex.raw()`, so existing SQL syntax stays untouched:

```js
exports.up   = knex => knex.raw(`ALTER TABLE knobit_progress ADD COLUMN IF NOT EXISTS started_at DATETIME NULL`);
exports.down = knex => knex.raw(`ALTER TABLE knobit_progress DROP COLUMN started_at`);
```

A minimal `knexfile.js` at the project root reads the existing `DB_*` env vars — nothing else in the codebase changes. The JSON-to-DB seed logic in the current `migrate.js` moves to `seeds/`, which Knex also manages (`knex seed:run`), cleanly separating schema migrations from data seeding.

This is also a sensible incremental path: Knex is already a dependency, so if Postgres support or query-builder safety (e.g. the empty-IN bug) becomes a priority later, individual routes can be migrated to use the query builder one at a time without a big-bang rewrite of all 3,000 lines.

---

### 18. No TypeScript

The entire codebase is plain JavaScript. This means there are no explicit contracts between modules, between routes and their callers, or between the LLM service and the rest of the app. Shapes are implicit — a reader (human or AI assistant) must trace through multiple files to understand what a function accepts and returns. Errors that a compiler would catch in milliseconds surface instead at runtime, often in production.

The concrete gaps this creates in this codebase:

- **`req.user`** is accessed with `?.` defensive chaining 100+ times because its shape is never declared
- **LLM response shapes** — every `parseJSON()` / `_extractJSON()` call returns an untyped object; a wrong field name or missing key is only discovered when a user hits that code path
- **Route request bodies** — 60+ routes each expect a specific body shape that is invisible to the editor and to code review
- **Cross-module contracts** — `window.Learn.open()`, `window.MapView.setFilter()`, `game.awardLumens()` etc. have no declared signatures; callers have to read the implementation to know what to pass

Adding TypeScript to the server is a bounded, incremental change — add `tsc`, annotate `req.user`, add interfaces for LLM responses and route bodies, and errors that currently require a running server to discover are caught at compile time. The frontend requires more work (a bundler and restructuring the IIFE modules) and is best treated as a separate later phase.

The primary value is not just catching bugs — it is making the codebase legible. Clearly defined interfaces are the fastest way for a new developer, a code reviewer, or an AI assistant to understand what a piece of code does and what it expects, without having to read every callsite.

### 19. No frontend framework — complex UI managed with imperative DOM manipulation

The entire frontend is vanilla JS with no framework. For the D3 map this is a reasonable choice — D3 owns the SVG and imperative DOM control is appropriate there. For everything else it is a liability.

`learning.js` (2,175 lines) and the profile, teacher, and parent pages are almost entirely imperative DOM manipulation: creating elements, appending children, toggling visibility, and updating text in response to state changes. The learning flow alone tracks a dozen pieces of state (current knobit, current phase, byte index, streaming blocks, retry counts, prior choices, note mode, etc.) all as module-level variables, with UI updates scattered across dozens of functions. A reactive component model would describe the UI as a function of that state and eliminate the manual synchronisation entirely — likely halving the line count and making the data flow legible.

**The D3 constraint** shapes the choice of framework. React's virtual DOM conflicts with D3's direct DOM mutations, requiring careful ref gymnastics. Vue 3 and Svelte coexist with D3 naturally — both allow D3 to own its SVG element while the framework owns everything around it. Svelte is the strongest fit: it compiles to direct DOM operations (same model as D3), has the lowest learning curve from vanilla JS, and produces no runtime overhead.

**The recommended approach is an islands architecture:** keep D3 owning the map canvas as a single isolated component, and build everything else — the learning overlay, sidebar, profile, teacher and parent dashboards — as framework components. This avoids the D3 conflict entirely and allows incremental migration one page or feature at a time rather than a big-bang rewrite.

Adopting a framework also requires **Vite** as a bundler, which is the same infrastructure needed for TypeScript on the frontend (weakness #18). The two are effectively one project and should be done together.

| | D3 coexistence | Learning curve | TS support | Ecosystem |
|---|---|---|---|---|
| **Svelte** | ★★★★★ | Low | Good | Small |
| **Vue 3** | ★★★★☆ | Low–medium | Good | Large |
| **React** | ★★☆☆☆ | Medium | Excellent | Largest |

---

## Summary Table

| Area | Rating | Notes |
|---|---|---|
| LLM integration | ★★★★★ | Prompt caching, fail-open, streaming, robust JSON parsing |
| Authorization | ★★★★☆ | Per-route relationship checks; missing CSRF |
| SQL safety | ★★★★☆ | Fully parameterised; `SELECT *` / empty-IN edge cases |
| Frontend architecture | ★★☆☆☆ | Clear module contracts; no framework, no bundler; imperative DOM at scale |
| Security hardening | ★★☆☆☆ | No Helmet, no CSRF, no rate limiting on LLM routes |
| Observability | ★★☆☆☆ | No structured logging, TESTLOG in production |
| Testability | ★☆☆☆☆ | Zero tests |
| Code organisation | ★★★☆☆ | One 3,000-line route file; services are well-separated |
| Performance | ★★☆☆☆ | Good DB/LLM caching; SVG map lags with 2k+ nodes; getUserLocale N+1 |