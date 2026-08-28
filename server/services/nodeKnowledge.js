const db = require('../db');

// Recompute and store estimated knowledge % for all ancestors of a node.
// Called fire-and-forget after any knowledge write. Never overwrites
// explicit self_reported or tested entries.
// Extracted from server/routes/api.js (2026-08-28) so server/routes/
// knowledgeEstimate.js can reuse the exact same rollup logic after writing
// new L5 percentages, instead of duplicating this recursive-CTE logic.
async function updateAncestorKnowledge(passportId, nodeExtId) {
  if (!passportId) return;
  try {
    const [ancestors] = await db.execute(
      `WITH RECURSIVE anc AS (
         SELECT id AS db_id, external_id, level, parent_id
         FROM nodes WHERE external_id = ?
         UNION ALL
         SELECT n.id, n.external_id, n.level, n.parent_id
         FROM nodes n JOIN anc a ON n.id = a.parent_id
       )
       SELECT db_id, external_id FROM anc
       WHERE external_id != ? AND level >= 1
       ORDER BY level DESC`,
      [nodeExtId, nodeExtId]
    );

    for (const anc of ancestors) {
      // Compute average % from all L5 descendants
      const [[{ total, sumPct }]] = await db.execute(
        `WITH RECURSIVE desc_tree AS (
           SELECT id, external_id, level FROM nodes WHERE id = ?
           UNION ALL
           SELECT n.id, n.external_id, n.level
           FROM nodes n JOIN desc_tree d ON n.parent_id = d.id
         )
         SELECT COUNT(d.id) AS total,
                COALESCE(SUM(unk.percentage), 0) AS sumPct
         FROM desc_tree d
         LEFT JOIN user_node_knowledge unk
                ON unk.node_external_id = d.external_id
               AND unk.passport_id = ?
         WHERE d.level = 5`,
        [anc.db_id, passportId]
      );

      if (!total) continue;

      // Never touch explicit self_reported or tested entries
      const [existing] = await db.execute(
        `SELECT source FROM user_node_knowledge WHERE passport_id = ? AND node_external_id = ?`,
        [passportId, anc.external_id]
      );
      if (existing.length && ['self_reported', 'tested'].includes(existing[0].source)) continue;

      const estPct = Math.round(sumPct / total);

      if (estPct > 0) {
        await db.execute(
          `INSERT INTO user_node_knowledge
             (passport_id, node_external_id, percentage, source, updated_at)
           VALUES (?, ?, ?, 'estimated', NOW())
           ON DUPLICATE KEY UPDATE percentage = VALUES(percentage), source = 'estimated', updated_at = NOW()`,
          [passportId, anc.external_id, estPct]
        );
      } else {
        // Drop estimated row when % falls back to 0
        await db.execute(
          `DELETE FROM user_node_knowledge WHERE passport_id = ? AND node_external_id = ? AND source = 'estimated'`,
          [passportId, anc.external_id]
        );
      }
    }
  } catch (err) {
    console.error('[updateAncestorKnowledge]', err.message);
  }
}

module.exports = { updateAncestorKnowledge };
