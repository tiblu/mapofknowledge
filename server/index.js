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

// ── Continue-learning reminder — runs every hour ─────────────────────────────
// Ported from KnobitMap's goal-reminder cron, adapted to this project's schema:
// KnobitMap's goals can be tied to a map node, so it reminds about stale
// *node-based goals*. MoK's goals are free-text only (no node link — see
// passport_goals, no node_external_id column), so there's nothing directly
// equivalent to port. Instead this reminds about nodes the learner has
// genuinely started but not finished — user_node_knowledge rows with
// 0 < percentage < 100 whose updated_at (bumped on every knobit completion
// for that node) has gone stale. Dedup mirrors KnobitMap's: one
// continue_learning notification per user per 24h, even if multiple nodes
// qualify in the same run.
const db = require('./db');
const { notify } = require('./services/notifications');
setInterval(async () => {
  try {
    const [stale] = await db.execute(`
      SELECT DISTINCT u.id AS user_id,
        COALESCE(tr.label, n.label) AS node_label,
        unk.node_external_id AS node_ext_id
      FROM user_node_knowledge unk
      JOIN nodes n ON n.external_id = unk.node_external_id
      JOIN learner_passports lp ON unk.passport_id = lp.id
      JOIN users u ON u.passport_id = lp.id
      LEFT JOIN user_settings us ON us.user_id = u.id AND us.key_name = 'ui_locale'
      LEFT JOIN node_translations tr
        ON tr.node_external_id = n.external_id AND tr.locale = COALESCE(us.value, 'en')
      WHERE unk.percentage > 0 AND unk.percentage < 100
        AND unk.updated_at < DATE_SUB(NOW(), INTERVAL 48 HOUR)
        AND NOT EXISTS (
          SELECT 1 FROM notifications
          WHERE user_id = u.id AND type = 'continue_learning'
          AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
        )
    `);
    for (const row of stale) {
      notify(row.user_id, 'continue_learning', `Continue learning: ${row.node_label}`,
        `You made some progress here — come back and finish it!`, row.node_ext_id);
    }
  } catch (err) {
    console.error('[reminder]', err.message);
  }
}, 60 * 60 * 1000);
