// Builds a compact L1→L2→L3 tree of the knowledge map (domains → topics →
// subtopics) so Anne can discuss what the map actually covers instead of
// working blind. Individual concepts (L4/L5, ~10,000 nodes) are deliberately
// excluded — far too large for a chat system prompt; Anne is told each
// subtopic goes deeper on the actual map, so she can point a learner there
// instead of claiming ignorance or overclaiming leaf-level precision.
const db = require('../db');

const _cache = {}; // locale -> tree text, cleared on server restart (mirrors mapCaches/_stringsCache in api.js)

async function getMapOverviewText(locale) {
  if (_cache[locale]) return _cache[locale];

  const [rows] = locale === 'en'
    ? await db.execute(
        `SELECT id, label, level, parent_id FROM nodes
         WHERE is_active = 1 AND level <= 3 ORDER BY id`)
    : await db.execute(
        `SELECT n.id, COALESCE(tr.label, n.label) AS label, n.level, n.parent_id
         FROM nodes n
         LEFT JOIN node_translations tr
           ON tr.node_external_id = n.external_id AND tr.locale = ?
         WHERE n.is_active = 1 AND n.level <= 3 ORDER BY n.id`,
        [locale]);

  const byParent = {};
  rows.forEach(r => { (byParent[r.parent_id] = byParent[r.parent_id] || []).push(r); });

  const lines = [];
  function walk(node, depth) {
    lines.push('  '.repeat(depth) + '- ' + node.label);
    (byParent[node.id] || []).forEach(child => walk(child, depth + 1));
  }
  rows.filter(r => r.level === 1).forEach(r => walk(r, 0));

  const text = lines.join('\n');
  _cache[locale] = text;
  return text;
}

module.exports = { getMapOverviewText };
