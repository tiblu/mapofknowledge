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
//
// source != 'estimated' excludes updateAncestorKnowledge's rolled-up
// aggregate rows on L1-L4 ancestors (bug found 2026-07-29: without this,
// e.g. "Mathematics" (L1) would get reminded about because some L5
// descendant's progress rolls up an estimated % onto it too). Only rows
// written directly for the node the learner actually clicked "Learn this"
// on (currently L5 only, source 'tested' or 'self_reported') qualify.
//
// Bug found 2026-07-31: 'tested' is written by TWO unrelated things —
// /learn/knobit/:id/complete (real lesson progress: % of that node's
// knobits done) and the Q4 diagnostic-test route (finalScore, no lesson
// activity at all). Both share the same source value, so a node that was
// only ever tested (never opened via "Learn this") could still land
// between 0-100% and trigger this reminder. The EXISTS clause below
// requires an actual knobit_progress row for one of the node's knobits —
// something only real lesson engagement ever creates — to tell the two
// apart.
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
        AND unk.source != 'estimated'
        AND unk.updated_at < DATE_SUB(NOW(), INTERVAL 48 HOUR)
        AND EXISTS (
          SELECT 1 FROM knobit_progress kp
          JOIN knobits k ON kp.knobit_id = k.id
          WHERE kp.passport_id = unk.passport_id AND k.node_id = n.id
        )
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
