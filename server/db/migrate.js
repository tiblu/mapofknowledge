/**
 * One-time migration: JSON files → MariaDB
 * Also adds missing columns/tables if they don't exist yet.
 *
 * Run: node server/db/migrate.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const path  = require('path');
const fs    = require('fs');
const mysql = require('mysql2/promise');
const db    = require('./index');

const BASE_JSON     = path.join(__dirname, '../../app/knowledge_map.json');
const EMERGENT_JSON = path.join(__dirname, '../../app/knowledge_map_emergent.json');
const SCHEMA_SQL    = path.join(__dirname, 'schema.sql');

const BATCH = 500;

// Bootstraps a completely empty database from schema.sql — the ONLY thing
// this touches is a database with no `users` table at all, i.e. genuinely
// fresh. Everything else in this script is additive (ALTER/CREATE IF NOT
// EXISTS) against tables assumed to already exist, which was previously
// true only because the original schema-creation step lived nowhere in
// this repo — a fresh clone had no way to bootstrap a database at all.
// Ported from themapofknowledge.com's 2026-09-01 review, verified there
// directly against its own production DB (detection query correctly
// no-ops when tables exist; the mysql2 multipleStatements execution
// mechanism proven against disposable throwaway tables) before porting.
async function bootstrapSchemaIfNeeded() {
  const [tables] = await db.query("SHOW TABLES LIKE 'users'");
  if (tables.length) {
    console.log('Base schema already present — skipping bootstrap from schema.sql.');
    return;
  }
  console.log('No base schema detected (no `users` table) — bootstrapping from server/db/schema.sql...');
  const conn = await mysql.createConnection({
    host:     process.env.DB_HOST,
    port:     parseInt(process.env.DB_PORT || '3306'),
    user:     process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    multipleStatements: true, // only ever used for this one-shot file, never the shared app pool
  });
  try {
    const schemaSql = fs.readFileSync(SCHEMA_SQL, 'utf8');
    await conn.query(schemaSql);
    console.log('  + Base schema created from schema.sql.');
  } finally {
    await conn.end();
  }
}

async function run() {
  await bootstrapSchemaIfNeeded();

  const conn = await db.getConnection();
  try {
    console.log('=== KnoBitz — DB Migration ===\n');

    // ── 1. Schema additions ───────────────────────────────────────────────────
    console.log('Adding schema additions if needed...');

    await conn.execute(`
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS overview TEXT NULL AFTER is_active
    `).catch(() => {
      // Older MariaDB may not support ADD COLUMN IF NOT EXISTS — try the check manually
    });

    // Check if overview column exists, add if not
    const [cols] = await conn.execute(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nodes' AND COLUMN_NAME = 'overview'`
    );
    if (!cols.length) {
      await conn.execute('ALTER TABLE nodes ADD COLUMN overview TEXT NULL AFTER is_active');
      console.log('  + Added nodes.overview column');
    } else {
      console.log('  · nodes.overview already exists');
    }

    // user_node_knowledge table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS user_node_knowledge (
        id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        passport_id      BIGINT UNSIGNED NOT NULL,
        node_external_id VARCHAR(20)     NOT NULL,
        percentage       TINYINT UNSIGNED NOT NULL DEFAULT 0,
        source           ENUM('self_reported','tested') NOT NULL DEFAULT 'self_reported',
        updated_at       DATETIME NOT NULL DEFAULT NOW(),
        PRIMARY KEY (id),
        UNIQUE KEY uq_unk (passport_id, node_external_id),
        CONSTRAINT fk_unk_passport
          FOREIGN KEY (passport_id) REFERENCES learner_passports (id)
          ON DELETE CASCADE
      )
    `);
    console.log('  · user_node_knowledge table ready');

    // knobit_progress.started_at — stamped on first interaction (see
    // _saveInteraction in api.js), independent of completed_at. Used to
    // detect "whole node finished within 24h" for streak-saver eligibility.
    const [startedCols] = await conn.execute(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'knobit_progress' AND COLUMN_NAME = 'started_at'`
    );
    if (!startedCols.length) {
      await conn.execute('ALTER TABLE knobit_progress ADD COLUMN started_at DATETIME NULL AFTER phase_reached');
      console.log('  + Added knobit_progress.started_at column');
    } else {
      console.log('  · knobit_progress.started_at already exists');
    }

    // user_streaks table — daily-completion streak, independent of lumens.
    // last_completion_date is the LEARNER'S LOCAL calendar date (sent by the
    // client, not derived from server time) — see recordKnobitCompletion/
    // getStreak in game.js.
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS user_streaks (
        passport_id         BIGINT UNSIGNED NOT NULL,
        current_streak       INT UNSIGNED NOT NULL DEFAULT 0,
        longest_streak        INT UNSIGNED NOT NULL DEFAULT 0,
        streak_savers         TINYINT UNSIGNED NOT NULL DEFAULT 0,
        last_completion_date  DATE NULL,
        updated_at            DATETIME NOT NULL DEFAULT NOW() ON UPDATE NOW(),
        PRIMARY KEY (passport_id),
        CONSTRAINT fk_streaks_passport
          FOREIGN KEY (passport_id) REFERENCES learner_passports (id)
          ON DELETE CASCADE
      )
    `);
    console.log('  · user_streaks table ready');

    // lootbox_cache table — one generated Loot Box per (node, locale), reused
    // across every learner; regenerated when stale (see /api/learn/lootbox)
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS lootbox_cache (
        id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        node_external_id VARCHAR(20)     NOT NULL,
        locale           VARCHAR(10)     NOT NULL DEFAULT 'en',
        data             MEDIUMTEXT      NOT NULL,
        generated_at     DATETIME        NOT NULL DEFAULT NOW(),
        PRIMARY KEY (id),
        UNIQUE KEY uq_lootbox (node_external_id, locale)
      )
    `);
    console.log('  · lootbox_cache table ready');

    // learner_passports.profile_bonus_awarded — one-time flag so the +10
    // lumens "complete your profile" bonus can't be re-triggered on every
    // subsequent edit (see maybeAwardProfileCompleteBonus in game.js).
    const [profileBonusCols] = await conn.execute(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'learner_passports' AND COLUMN_NAME = 'profile_bonus_awarded'`
    );
    if (!profileBonusCols.length) {
      await conn.execute('ALTER TABLE learner_passports ADD COLUMN profile_bonus_awarded TINYINT(1) NOT NULL DEFAULT 0');
      console.log('  + Added learner_passports.profile_bonus_awarded column');
    } else {
      console.log('  · learner_passports.profile_bonus_awarded already exists');
    }

    // users.google_linked / discord_linked — tracks which SSO providers this
    // account has ever signed in via (Discord SSO + passkeys ported from
    // themapofknowledge.com). Backfilled below: any existing user with no
    // password_hash only ever could have signed up via Google (Discord/
    // passkeys didn't exist yet), so google_linked=1 is a safe inference —
    // needed so countAuthMethods (webauthn.js's "don't delete the last
    // sign-in method" guard) doesn't undercount pre-existing Google users.
    const [googleLinkedCols] = await conn.execute(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'google_linked'`
    );
    if (!googleLinkedCols.length) {
      await conn.execute('ALTER TABLE users ADD COLUMN google_linked TINYINT(1) NOT NULL DEFAULT 0');
      await conn.execute('UPDATE users SET google_linked = 1 WHERE password_hash IS NULL');
      console.log('  + Added users.google_linked column (backfilled for existing password-less accounts)');
    } else {
      console.log('  · users.google_linked already exists');
    }

    const [discordLinkedCols] = await conn.execute(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'discord_linked'`
    );
    if (!discordLinkedCols.length) {
      await conn.execute('ALTER TABLE users ADD COLUMN discord_linked TINYINT(1) NOT NULL DEFAULT 0');
      console.log('  + Added users.discord_linked column');
    } else {
      console.log('  · users.discord_linked already exists');
    }

    // users.password_reset_token / password_reset_expires — forgot-password
    // flow, ported from themapofknowledge.com.
    const [resetTokenCols] = await conn.execute(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'password_reset_token'`
    );
    if (!resetTokenCols.length) {
      await conn.execute('ALTER TABLE users ADD COLUMN password_reset_token VARCHAR(64) DEFAULT NULL');
      await conn.execute('ALTER TABLE users ADD COLUMN password_reset_expires DATETIME DEFAULT NULL');
      console.log('  + Added users.password_reset_token / password_reset_expires columns');
    } else {
      console.log('  · users.password_reset_token already exists');
    }

    // webauthn_credentials table — passkey sign-in, ported from
    // themapofknowledge.com.
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS webauthn_credentials (
        id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id       BIGINT UNSIGNED NOT NULL,
        credential_id VARCHAR(255) NOT NULL,
        public_key    TEXT NOT NULL,
        counter       BIGINT UNSIGNED NOT NULL DEFAULT 0,
        device_type   VARCHAR(32) DEFAULT NULL,
        backed_up     TINYINT(1) NOT NULL DEFAULT 0,
        transports    VARCHAR(255) DEFAULT NULL,
        nickname      VARCHAR(100) DEFAULT NULL,
        created_at    DATETIME NOT NULL DEFAULT NOW(),
        last_used_at  DATETIME DEFAULT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_webauthn_credential_id (credential_id),
        KEY idx_webauthn_user (user_id),
        CONSTRAINT fk_webauthn_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      )
    `);
    console.log('  · webauthn_credentials table ready');

    // ── 2. Check if already migrated ─────────────────────────────────────────
    const [[{ cnt }]] = await conn.execute('SELECT COUNT(*) AS cnt FROM nodes');
    if (cnt > 0) {
      console.log(`\nNodes table already has ${cnt} rows — skipping node/edge import.`);
      console.log('To re-migrate: TRUNCATE nodes and edges first, then re-run.\n');
      return;
    }

    // ── 3. Load JSON ──────────────────────────────────────────────────────────
    console.log('\nLoading JSON files...');
    const baseData     = JSON.parse(fs.readFileSync(BASE_JSON, 'utf8'));
    const emergentData = JSON.parse(fs.readFileSync(EMERGENT_JSON, 'utf8'));
    console.log(`  Base:     ${baseData.nodes.length} nodes, ${baseData.edges.length} edges`);
    console.log(`  Emergent: ${emergentData.nodes.length} nodes, ${emergentData.edges.length} edges`);

    // ── 4. Insert base nodes ──────────────────────────────────────────────────
    console.log('\nInserting base (foundational) nodes...');
    const extToDbId = {};  // external_id → db auto-increment id

    const baseNodes = baseData.nodes;
    for (let i = 0; i < baseNodes.length; i += BATCH) {
      const chunk = baseNodes.slice(i, i + BATCH);
      for (const n of chunk) {
        const extId = String(n.id);
        const [result] = await conn.execute(
          `INSERT INTO nodes (external_id, label, level, layer, is_active)
           VALUES (?, ?, ?, 'foundational', 1)`,
          [extId, n.label, n.level]
        );
        extToDbId[extId] = result.insertId;
      }
      process.stdout.write(`\r  ${Math.min(i + BATCH, baseNodes.length)} / ${baseNodes.length}`);
    }
    console.log('\n  Done.');

    // ── 5. Insert emergent nodes ──────────────────────────────────────────────
    console.log('Inserting emergent nodes...');
    const emergentNodes = emergentData.nodes;
    for (const n of emergentNodes) {
      const extId = String(n.id);
      const [result] = await conn.execute(
        `INSERT INTO nodes (external_id, label, level, layer, is_active)
         VALUES (?, ?, ?, 'emergent', 1)`,
        [extId, n.label, n.level]
      );
      extToDbId[extId] = result.insertId;
    }
    console.log(`  Done. (${emergentNodes.length} nodes)`);

    // ── 6. Insert base edges (hierarchy) ─────────────────────────────────────
    console.log('Inserting base hierarchy edges...');
    const baseEdges = baseData.edges;
    let edgeOk = 0, edgeSkip = 0;
    for (let i = 0; i < baseEdges.length; i += BATCH) {
      const chunk = baseEdges.slice(i, i + BATCH);
      for (const e of chunk) {
        const srcExt = String(e.source);
        const tgtExt = String(e.target);
        const srcId  = extToDbId[srcExt];
        const tgtId  = extToDbId[tgtExt];
        if (!srcId || !tgtId) { edgeSkip++; continue; }
        await conn.execute(
          `INSERT IGNORE INTO edges (source_node_id, target_node_id, edge_type)
           VALUES (?, ?, 'hierarchy')`,
          [srcId, tgtId]
        );
        edgeOk++;
      }
      process.stdout.write(`\r  ${Math.min(i + BATCH, baseEdges.length)} / ${baseEdges.length}`);
    }
    console.log(`\n  Done. (${edgeOk} inserted, ${edgeSkip} skipped)`);

    // ── 7. Update parent_id from hierarchy edges ──────────────────────────────
    console.log('Setting parent_id from hierarchy edges...');
    await conn.execute(`
      UPDATE nodes n
      JOIN edges e ON e.target_node_id = n.id AND e.edge_type = 'hierarchy'
      SET n.parent_id = e.source_node_id
    `);
    console.log('  Done.');

    // ── 8. Insert emergent edges ──────────────────────────────────────────────
    console.log('Inserting emergent edges...');
    const emergentEdges = emergentData.edges;
    for (const e of emergentEdges) {
      const srcExt = String(e.source);
      const tgtExt = String(e.target);
      const srcId  = extToDbId[srcExt];
      const tgtId  = extToDbId[tgtExt];
      if (!srcId || !tgtId) continue;

      // Normalize: 'hierarchical' → 'hierarchy', 'draws_from' stays
      const edgeType = e.edge_type === 'hierarchical' ? 'hierarchy' : 'draws_from';
      await conn.execute(
        `INSERT IGNORE INTO edges (source_node_id, target_node_id, edge_type)
         VALUES (?, ?, ?)`,
        [srcId, tgtId, edgeType]
      );
    }
    console.log(`  Done. (${emergentEdges.length} edges)`);

    // ── Summary ───────────────────────────────────────────────────────────────
    const [[nodeCount]] = await conn.execute('SELECT COUNT(*) AS c FROM nodes');
    const [[edgeCount]] = await conn.execute('SELECT COUNT(*) AS c FROM edges');
    console.log(`\n=== Migration complete ===`);
    console.log(`  Nodes: ${nodeCount.c}`);
    console.log(`  Edges: ${edgeCount.c}`);

  } finally {
    conn.release();
    process.exit(0);
  }
}

run().catch(err => {
  console.error('\nMigration failed:', err);
  process.exit(1);
});
