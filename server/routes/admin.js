const express      = require('express');
const { randomUUID } = require('crypto');
const db           = require('../db');
const router       = express.Router();

function requireSuperAdmin(req, res, next) {
  if (!req.isAuthenticated() || req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}
router.use(requireSuperAdmin);

// ── GET /api/admin/users ──────────────────────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT
        u.id,
        u.email,
        u.role,
        u.subscription_status,
        u.created_at,
        u.last_login,
        u.passport_id,
        lp.display_name,
        lp.birth_year,
        COALESCE(kp.knobits_done, 0)  AS knobits_done,
        COALESCE(tu.token_calls, 0)      AS token_calls,
        COALESCE(tu.estimated_cost, 0)   AS estimated_cost
      FROM users u
      LEFT JOIN learner_passports lp ON lp.id = u.passport_id
      LEFT JOIN (
        SELECT passport_id, COUNT(*) AS knobits_done
        FROM knobit_progress
        WHERE phase_reached = 'done'
        GROUP BY passport_id
      ) kp ON kp.passport_id = u.passport_id
      LEFT JOIN (
        SELECT user_id,
               COUNT(*)                                               AS token_calls,
               SUM(input_tokens * 3.0 + output_tokens * 15.0) / 1e6 AS estimated_cost
        FROM token_usage
        GROUP BY user_id
      ) tu ON tu.user_id = u.id
      ORDER BY u.id
    `);
    res.json(rows);
  } catch (err) {
    console.error('admin GET /users', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/admin/users ─────────────────────────────────────────────────────
router.post('/users', async (req, res) => {
  const { email, role } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  const validRoles = ['learner', 'teacher', 'parent', 'admin'];
  const safeRole = validRoles.includes(role) ? role : 'learner';
  try {
    const [pr] = await db.execute(
      'INSERT INTO learner_passports (public_id) VALUES (?)',
      [randomUUID()]
    );
    const [ur] = await db.execute(
      'INSERT INTO users (email, role, subscription_status, passport_id, created_at) VALUES (?, ?, ?, ?, NOW())',
      [email.toLowerCase().trim(), safeRole, 'free', pr.insertId]
    );
    res.json({ id: ur.insertId, passport_id: pr.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Email already exists' });
    console.error('admin POST /users', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PATCH /api/admin/users/:id ────────────────────────────────────────────────
router.patch('/users/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (id === 1) return res.status(403).json({ error: 'Cannot modify root super_admin' });
  const { email, role, subscription_status } = req.body;
  const validRoles = ['learner', 'teacher', 'parent', 'admin', 'super_admin'];
  const validTiers = ['free', 'subscriber', 'cancelled'];
  const sets = [];
  const vals = [];
  if (email)               { sets.push('email = ?');               vals.push(email.toLowerCase().trim()); }
  if (role && validRoles.includes(role))
                           { sets.push('role = ?');                vals.push(role); }
  if (subscription_status && validTiers.includes(subscription_status))
                           { sets.push('subscription_status = ?'); vals.push(subscription_status); }
  if (!sets.length) return res.json({ ok: true });
  vals.push(id);
  try {
    await db.execute(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, vals);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Email already exists' });
    console.error('admin PATCH /users/:id', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── DELETE /api/admin/users/:id ───────────────────────────────────────────────
router.delete('/users/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (id === 1) return res.status(403).json({ error: 'Cannot delete root super_admin' });
  try {
    await db.execute('DELETE FROM users WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('admin DELETE /users/:id', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
