/**
 * One-time migration: JSON files → MariaDB
 * Also adds missing columns/tables if they don't exist yet.
 *
 * Run: node server/db/migrate.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const path = require('path');
const fs   = require('fs');
const db   = require('./index');

const BASE_JSON     = path.join(__dirname, '../../app/knowledge_map.json');
const EMERGENT_JSON = path.join(__dirname, '../../app/knowledge_map_emergent.json');

const BATCH = 500;

async function run() {
  const conn = await db.getConnection();
  try {
    console.log('=== Map of Knowledge — DB Migration ===\n');

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

    // webauthn_credentials table — passkeys (Face ID / Touch ID / Windows
    // Hello / security keys) registered as an additional sign-in method on
    // top of an existing password/Google account. See server/routes/webauthn.js.
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS webauthn_credentials (
        id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id       BIGINT UNSIGNED NOT NULL,
        credential_id VARCHAR(255)    NOT NULL,
        public_key    TEXT            NOT NULL,
        counter       BIGINT UNSIGNED NOT NULL DEFAULT 0,
        device_type   VARCHAR(32)     NULL,
        backed_up     TINYINT(1)      NOT NULL DEFAULT 0,
        transports    VARCHAR(255)    NULL,
        nickname      VARCHAR(100)    NULL,
        created_at    DATETIME        NOT NULL DEFAULT NOW(),
        last_used_at  DATETIME        NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_webauthn_credential_id (credential_id),
        KEY idx_webauthn_user (user_id),
        CONSTRAINT fk_webauthn_user
          FOREIGN KEY (user_id) REFERENCES users (id)
          ON DELETE CASCADE
      )
    `);
    console.log('  · webauthn_credentials table ready');

    // users.*_linked — tracks which SSO providers an account has actually
    // signed in with, purely for the Account page's "Sign-in method"
    // badges (see handleOAuthLogin in auth.js, which sets these on every
    // successful login/signup via that provider). Backfill: before Discord/
    // LinkedIn existed, Google was the only way to get an account with no
    // password, so any such existing row must have used Google.
    for (const col of ['google_linked', 'discord_linked', 'linkedin_linked']) {
      const [linkedCols] = await conn.execute(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = '${col}'`
      );
      if (!linkedCols.length) {
        await conn.execute(`ALTER TABLE users ADD COLUMN ${col} TINYINT(1) NOT NULL DEFAULT 0`);
        console.log(`  + Added users.${col} column`);
      } else {
        console.log(`  · users.${col} already exists`);
      }
    }
    const [backfill] = await conn.execute(
      'UPDATE users SET google_linked = 1 WHERE password_hash IS NULL AND google_linked = 0'
    );
    console.log(`  · Backfilled google_linked for ${backfill.affectedRows} passwordless pre-existing account(s)`);

    // users.password_reset_token / _expires — "Forgot password?" flow, same
    // shape as the existing email_verify_token/_expires pair.
    for (const col of ['password_reset_token', 'password_reset_expires']) {
      const [resetCols] = await conn.execute(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = '${col}'`
      );
      if (!resetCols.length) {
        const def = col === 'password_reset_token' ? 'VARCHAR(64) NULL' : 'DATETIME NULL';
        await conn.execute(`ALTER TABLE users ADD COLUMN ${col} ${def}`);
        console.log(`  + Added users.${col} column`);
      } else {
        console.log(`  · users.${col} already exists`);
      }
    }

    // friend_invites — "Invite a friend" (Passport > Individuals). One row
    // per invite sent; relationship_id links to the passport_relationships
    // "Friend" entry created at the same time. status flips sent -> joined
    // the moment anyone signs up with invitee_email, regardless of which of
    // the 4 signup methods they use (see checkFriendJoinBonus in
    // server/services/invites.js) — deliberately NOT a referral-token/link
    // scheme, just a plain email match, so nothing needs threading through
    // the OAuth redirect flows. If they join with a different email, the
    // inviter simply doesn't get the second bonus — no tracking attempted.
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS friend_invites (
        id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        inviter_passport_id  BIGINT UNSIGNED NOT NULL,
        relationship_id      BIGINT UNSIGNED NOT NULL,
        invitee_name         VARCHAR(255)    NOT NULL,
        invitee_email        VARCHAR(255)    NOT NULL,
        status               ENUM('sent','joined') NOT NULL DEFAULT 'sent',
        created_at           DATETIME        NOT NULL DEFAULT NOW(),
        joined_at            DATETIME        NULL,
        PRIMARY KEY (id),
        KEY idx_invite_email (invitee_email),
        KEY idx_invite_inviter (inviter_passport_id),
        CONSTRAINT fk_invite_passport
          FOREIGN KEY (inviter_passport_id) REFERENCES learner_passports (id)
          ON DELETE CASCADE,
        CONSTRAINT fk_invite_relationship
          FOREIGN KEY (relationship_id) REFERENCES passport_relationships (id)
          ON DELETE CASCADE
      )
    `);
    console.log('  · friend_invites table ready');

    // users.avatar_url / avatar_source — profile photo pulled from Google at
    // login (profile.photos[0].value from its userinfo response). Kept as a
    // separate source flag so a future user-upload feature can overwrite
    // avatar_url and never get silently clobbered by the next Google
    // login — see the conditional UPDATE in handleOAuthLogin (auth.js),
    // which only touches these columns when avatar_source isn't 'upload'.
    const [avatarCols] = await conn.execute(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'avatar_url'`
    );
    if (!avatarCols.length) {
      await conn.execute("ALTER TABLE users ADD COLUMN avatar_url VARCHAR(500) NULL");
      await conn.execute("ALTER TABLE users ADD COLUMN avatar_source ENUM('upload','google') NULL");
      console.log('  + Added users.avatar_url / avatar_source columns');
    } else {
      console.log('  · users.avatar_url already exists');
    }

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
