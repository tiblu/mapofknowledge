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

// Resolves the ?period= query param into a [from, to] date range (inclusive,
// 'YYYY-MM-DD' strings) for the cost column — null means all-time (no filter).
function _periodRange(period, from, to) {
  const today = new Date();
  const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

  if (period === '7d') {
    const start = new Date(today); start.setDate(start.getDate() - 6);
    return { from: ymd(start), to: null };
  }
  if (period === '30d') {
    const start = new Date(today); start.setDate(start.getDate() - 29);
    return { from: ymd(start), to: null };
  }
  if (period === 'month') {
    return { from: ymd(new Date(today.getFullYear(), today.getMonth(), 1)), to: null };
  }
  if (period === 'custom' && /^\d{4}-\d{2}-\d{2}$/.test(from || '')) {
    return { from, to: /^\d{4}-\d{2}-\d{2}$/.test(to || '') ? to : null };
  }
  return null;
}

// ── GET /api/admin/users ──────────────────────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const range = _periodRange(req.query.period, req.query.from, req.query.to);
    let costDateClause = '';
    const costParams = [];
    if (range) {
      costDateClause += ' AND created_at >= ?';
      costParams.push(range.from + ' 00:00:00');
      if (range.to) {
        costDateClause += ' AND created_at <= ?';
        costParams.push(range.to + ' 23:59:59');
      }
    }

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
        COALESCE(kp.knobits_done, 0)                                    AS knobits_done,
        COALESCE(tu.estimated_cost, 0)                                  AS estimated_cost
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
               SUM(input_tokens * 3.0 + output_tokens * 15.0) / 1e6 AS estimated_cost
        FROM token_usage
        WHERE 1=1 ${costDateClause}
        GROUP BY user_id
      ) tu ON tu.user_id = u.id
      ORDER BY u.id
    `, costParams);

    // 7-day token activity per user (for sparklines)
    const [activityRows] = await db.execute(`
      SELECT user_id,
             DATE_FORMAT(DATE(created_at), '%Y-%m-%d') AS day,
             SUM(input_tokens + output_tokens)          AS tokens
      FROM token_usage
      WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
      GROUP BY user_id, DATE(created_at)
    `);

    const activityMap = {};
    for (const r of activityRows) {
      const uid = r.user_id;
      if (!activityMap[uid]) activityMap[uid] = {};
      activityMap[uid][r.day] = Number(r.tokens);
    }

    // Build 7-day array in local time to match DATE() in MariaDB
    const today = new Date();
    function localYMD(d) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() - (6 - i));
      return localYMD(d);
    });

    for (const u of rows) {
      const ua = activityMap[u.id] || {};
      u.activity7d = days.map(d => ua[d] || 0);
    }

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
    const [[user]] = await db.execute('SELECT passport_id FROM users WHERE id = ?', [id]);
    await db.execute('DELETE FROM users WHERE id = ?', [id]);
    if (user && user.passport_id) {
      await db.execute('DELETE FROM learner_passports WHERE id = ?', [user.passport_id]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('admin DELETE /users/:id', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Links (support tooling — view/create/disconnect any teacher/parent ↔
//    learner connection) ────────────────────────────────────────────────────
router.get('/links', async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const params = [];
    let whereClause = '';
    if (search) {
      whereClause = `WHERE lp.display_name LIKE ? OR lu.email LIKE ? OR llu.email LIKE ?`;
      const term = `%${search}%`;
      params.push(term, term, term);
    }
    const [rows] = await db.execute(
      `SELECT ll.id, ll.role, ll.status, ll.invited_at, ll.accepted_at,
              lp.display_name AS learner_name, lu.email AS learner_email,
              llu.email AS linked_email, llu.role AS linked_account_role
       FROM learner_links ll
       LEFT JOIN learner_passports lp ON lp.id = ll.passport_id
       LEFT JOIN users lu ON lu.passport_id = ll.passport_id
       LEFT JOIN users llu ON llu.id = ll.linked_user_id
       ${whereClause}
       ORDER BY ll.id DESC
       LIMIT 200`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('admin GET /links', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/links', async (req, res) => {
  const { learnerEmail, linkedEmail, role } = req.body || {};
  if (!['teacher', 'parent'].includes(role)) return res.status(400).json({ error: 'role must be teacher or parent' });
  if (!learnerEmail || !linkedEmail) return res.status(400).json({ error: 'learnerEmail and linkedEmail required' });
  try {
    const [[learner]] = await db.execute(
      'SELECT id, passport_id FROM users WHERE email = ?', [String(learnerEmail).toLowerCase().trim()]
    );
    if (!learner || !learner.passport_id) return res.status(404).json({ error: 'learner_not_found' });
    const [[linked]] = await db.execute(
      'SELECT id FROM users WHERE email = ?', [String(linkedEmail).toLowerCase().trim()]
    );
    if (!linked) return res.status(404).json({ error: 'linked_not_found' });
    if (linked.id === learner.id) return res.status(400).json({ error: 'self' });

    const [existing] = await db.execute(
      'SELECT id FROM learner_links WHERE passport_id = ? AND linked_user_id = ? AND role = ?',
      [learner.passport_id, linked.id, role]
    );
    if (existing.length) {
      await db.execute(`UPDATE learner_links SET status = 'active', accepted_at = NOW() WHERE id = ?`, [existing[0].id]);
      return res.json({ ok: true, id: existing[0].id });
    }
    const [ins] = await db.execute(
      `INSERT INTO learner_links (passport_id, linked_user_id, role, status, accepted_at, invited_at)
       VALUES (?, ?, ?, 'active', NOW(), NOW())`,
      [learner.passport_id, linked.id, role]
    );
    res.json({ ok: true, id: ins.insertId });
  } catch (err) {
    console.error('admin POST /links', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/links/:id', async (req, res) => {
  try {
    await db.execute(`UPDATE learner_links SET status = 'revoked' WHERE id = ?`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('admin DELETE /links/:id', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
