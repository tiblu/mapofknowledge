const express = require('express');
const bcrypt  = require('bcryptjs'); // pure-JS, matches server/routes/auth.js — no native compile step
const db      = require('../db');
const router  = express.Router();

// ── GET /api/account — Security/Data/Billing page bootstrap ─────────────────
router.get('/', async (req, res) => {
  try {
    const [[user]] = await db.execute(
      `SELECT email, password_hash, subscription_status, created_at, email_verified,
              google_linked, discord_linked, linkedin_linked
       FROM users WHERE id = ?`,
      [req.user.id]
    );
    const [[{ passkeyCount }]] = await db.execute(
      'SELECT COUNT(*) AS passkeyCount FROM webauthn_credentials WHERE user_id = ?',
      [req.user.id]
    );
    res.json({
      email:              user.email,
      hasPassword:        !!user.password_hash,
      hasPasskey:         passkeyCount > 0,
      hasGoogle:          !!user.google_linked,
      hasDiscord:         !!user.discord_linked,
      hasLinkedin:        !!user.linkedin_linked,
      subscriptionStatus: user.subscription_status,
      memberSince:        user.created_at,
      emailVerified:      !!user.email_verified,
    });
  } catch (err) {
    console.error('[api/account GET]', err.message);
    res.status(500).json({ error: 'Failed to load account' });
  }
});

// ── POST /api/account/password — change password, or set one for the first
//    time on a Google-only account (no currentPassword required then) ──────
router.post('/password', async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ error: 'weak_password' });
  }
  try {
    const [[user]] = await db.execute('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    if (user.password_hash) {
      if (typeof currentPassword !== 'string' || !currentPassword) {
        return res.status(400).json({ error: 'current_password_required' });
      }
      const match = await bcrypt.compare(currentPassword, user.password_hash);
      if (!match) return res.status(401).json({ error: 'wrong_password' });
    }
    const hash = await bcrypt.hash(newPassword, 12);
    await db.execute('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[api/account/password]', err.message);
    res.status(500).json({ error: 'update_failed' });
  }
});

// ── GET /api/account/export — GDPR-style personal data export ───────────────
router.get('/export', async (req, res) => {
  const userId     = req.user.id;
  const passportId = req.user.passport_id;
  try {
    const [[account]] = await db.execute(
      'SELECT email, role, subscription_status, created_at, last_login FROM users WHERE id = ?',
      [userId]
    );

    const data = { exportedAt: new Date().toISOString(), account, passport: null };

    if (passportId) {
      const [[passport]]    = await db.execute('SELECT * FROM learner_passports WHERE id = ?', [passportId]);
      const [tags]          = await db.execute('SELECT type, text FROM passport_tags WHERE passport_id = ? ORDER BY sort_order', [passportId]);
      const [credentials]   = await db.execute('SELECT type, title, issuer, awarded_date, grade, score_pct FROM passport_credentials WHERE passport_id = ?', [passportId]);
      const [competence]    = await db.execute('SELECT type, name, level, proficiency_label, source FROM passport_competence WHERE passport_id = ?', [passportId]);
      const [events]        = await db.execute('SELECT event_date, title, institution, result, type FROM passport_events WHERE passport_id = ?', [passportId]);
      const [reflections]   = await db.execute('SELECT text, created_at FROM passport_reflections WHERE passport_id = ?', [passportId]);
      const [relationships] = await db.execute('SELECT type, name, role_description, status FROM passport_relationships WHERE passport_id = ?', [passportId]);
      const [goals]         = await db.execute('SELECT text, status, created_at, completed_at FROM passport_goals WHERE passport_id = ?', [passportId]);
      const [aspirations]   = await db.execute('SELECT text FROM passport_aspirations WHERE passport_id = ?', [passportId]);
      const [objectives]    = await db.execute('SELECT title, target_date, target_description, status FROM passport_objectives WHERE passport_id = ?', [passportId]);
      const [plans]         = await db.execute('SELECT frequency, title, description FROM passport_plans WHERE passport_id = ?', [passportId]);
      const [[learningStyle]] = await db.execute('SELECT modalities, peak_time, session_length, works_best, needs, accessibility FROM passport_learning_style WHERE passport_id = ?', [passportId]);
      const [nodeKnowledge]  = await db.execute('SELECT node_external_id, percentage, source, updated_at FROM user_node_knowledge WHERE passport_id = ?', [passportId]);
      const [achievements]   = await db.execute('SELECT achievement_key, unlocked_at FROM user_achievements WHERE passport_id = ?', [passportId]);
      const [lumens]         = await db.execute('SELECT amount, reason, multiplier, created_at FROM lumen_transactions WHERE passport_id = ? ORDER BY created_at', [passportId]);
      const [[streak]]       = await db.execute('SELECT current_streak, longest_streak, streak_savers, last_completion_date FROM user_streaks WHERE passport_id = ?', [passportId]);

      data.passport = {
        displayName: passport?.display_name || null,
        birthYear:   passport?.birth_year || null,
        location:    passport?.location || null,
        culturalBackground: passport?.cultural_background || null,
        about:       passport?.about || null,
        lumenTotal:  passport?.lumen_total ?? 0,
        tags, credentials, competence, events, reflections, relationships,
        goals, aspirations, objectives, plans,
        learningStyle: learningStyle || null,
        nodeKnowledge, achievements, lumenTransactions: lumens,
        streak: streak || null,
      };
    }

    const [notifications] = await db.execute(
      'SELECT type, title, body, is_read, created_at FROM notifications WHERE user_id = ? ORDER BY created_at', [userId]
    );
    const [settings] = await db.execute('SELECT key_name, value FROM user_settings WHERE user_id = ?', [userId]);
    data.notifications = notifications;
    data.settings = settings.reduce((o, r) => { o[r.key_name] = r.value; return o; }, {});

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="map-of-knowledge-data-export.json"');
    res.send(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[api/account/export]', err.message);
    res.status(500).json({ error: 'export_failed' });
  }
});

// ── DELETE /api/account — deletes the account and erases personal data.
//    Doubles as the GDPR "forget me" request: MoK has no billing/legal
//    retention obligations and no support queue, so a separate erasure
//    request would just be a second button performing the identical action.
//    Requires the current password (if one is set) plus a typed "DELETE"
//    confirmation from the client, so a lone fetch can't trigger this. ──────
router.delete('/', async (req, res) => {
  const userId     = req.user.id;
  const passportId = req.user.passport_id;
  const { password } = req.body;

  try {
    const [[user]] = await db.execute('SELECT password_hash FROM users WHERE id = ?', [userId]);
    if (user.password_hash) {
      if (typeof password !== 'string' || !password) {
        return res.status(400).json({ error: 'password_required' });
      }
      const match = await bcrypt.compare(password, user.password_hash);
      if (!match) return res.status(401).json({ error: 'wrong_password' });
    }

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      if (passportId) {
        // These three tables have no FK back to learner_passports, so the
        // passport-delete cascade below won't reach them — must go first.
        await conn.execute('DELETE FROM lumen_transactions WHERE passport_id = ?', [passportId]);
        await conn.execute('DELETE FROM user_achievements WHERE passport_id = ?', [passportId]);
        await conn.execute('DELETE FROM user_momentum WHERE passport_id = ?', [passportId]);
        await conn.execute('DELETE FROM passport_goals WHERE passport_id = ?', [passportId]);
        // Cascades: passport_learning_style, passport_tags, passport_events,
        // passport_reflections, passport_relationships, passport_credentials,
        // passport_competence, passport_aspirations, passport_objectives,
        // passport_plans, knobit_progress, knobit_interactions,
        // user_node_knowledge, anne_messages, user_streaks.
        await conn.execute('DELETE FROM learner_passports WHERE id = ?', [passportId]);
      }

      // token_usage has no FK at all — anonymize rather than delete, matching
      // llm_usage_log's existing ON DELETE SET NULL retention-for-accounting design.
      await conn.execute('UPDATE token_usage SET user_id = NULL WHERE user_id = ?', [userId]);

      // Cascades: oauth_identities, notifications, user_settings.
      // knowledge_subsets.created_by is ON DELETE SET NULL (filters survive, orphaned).
      await conn.execute('DELETE FROM users WHERE id = ?', [userId]);

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    req.logout(() => res.json({ ok: true }));
  } catch (err) {
    console.error('[api/account DELETE]', err.message);
    res.status(500).json({ error: 'delete_failed' });
  }
});

module.exports = router;
