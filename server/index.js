const app    = require('./app');
const fs     = require('fs');
const PORT   = process.env.PORT   || 3000;
const SOCKET = process.env.SOCKET || null;

const target = SOCKET || PORT;

if (SOCKET && fs.existsSync(SOCKET)) fs.unlinkSync(SOCKET);

const server = app.listen(target, () => {
  if (SOCKET) fs.chmodSync(SOCKET, '777');  // allow Apache to write
  console.log(`[MoK] Server listening on ${SOCKET ? 'socket ' + SOCKET : 'port ' + PORT} — ${new Date().toISOString()}`);
});

// ── Goal reminder — runs every hour ──────────────────────────────────────────
const db = require('./db');
const { notify } = require('./services/notifications');
setInterval(async () => {
  try {
    const [stale] = await db.execute(`
      SELECT DISTINCT u.id AS user_id, n.label AS node_label
      FROM passport_goals pg
      JOIN learner_passports lp ON pg.passport_id = lp.id
      JOIN users u ON u.passport_id = lp.id
      JOIN nodes n ON n.external_id = pg.node_external_id
      WHERE pg.status = 'in_progress'
        AND pg.node_external_id IS NOT NULL
        AND (
          SELECT MAX(kp.completed_at) FROM knobit_progress kp
          WHERE kp.passport_id = lp.id
        ) < DATE_SUB(NOW(), INTERVAL 48 HOUR)
        AND NOT EXISTS (
          SELECT 1 FROM notifications
          WHERE user_id = u.id AND type = 'goal_reminder'
          AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
        )
    `);
    for (const row of stale) {
      notify(row.user_id, 'goal_reminder', 'Jätka õppimist 📚',
        `Sul on aktiivne eesmärk: "${row.node_label}". Tule tagasi!`);
    }
  } catch (err) {
    console.error('[reminder]', err.message);
  }
}, 60 * 60 * 1000);
