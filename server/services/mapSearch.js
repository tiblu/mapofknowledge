// Implements the "search_map" tool Anne can call on demand (see llm.js).
// Superseded the earlier approach of prepending a full L1-L3 map tree to
// every Anne system prompt — most conversations have nothing to do with the
// map at all, so that cost was paid on every single message for no reason.
// A tool call only happens when the learner actually asks something the
// map's content is relevant to, and it can search all five levels (not
// just L1-L3, since there's no longer a size ceiling to stay under).
const db = require('../db');

const MAX_RESULTS = 12;

// Escapes LIKE wildcards in the search term — backslash is MySQL/MariaDB's
// default LIKE escape char, so no explicit ESCAPE clause is needed.
function _escapeLike(s) {
  return s.replace(/[\\%_]/g, ch => '\\' + ch);
}

// Number of direct active children per db id, for every id given.
async function _childCounts(dbIds) {
  if (!dbIds.length) return {};
  const placeholders = dbIds.map(() => '?').join(',');
  const [rows] = await db.execute(
    `SELECT parent_id, COUNT(*) AS n FROM nodes WHERE is_active = 1 AND parent_id IN (${placeholders}) GROUP BY parent_id`,
    dbIds
  );
  const out = {};
  rows.forEach(r => { out[r.parent_id] = r.n; });
  return out;
}

async function searchMapNodes(query, locale) {
  const term = (query || '').trim();
  if (!term) return 'No search term given.';
  const pattern = `%${_escapeLike(term)}%`;

  const [matches] = locale === 'en'
    ? await db.execute(
        `SELECT id, external_id, level, label FROM nodes
         WHERE is_active = 1 AND label LIKE ?
         ORDER BY level ASC, LENGTH(label) ASC LIMIT ?`,
        [pattern, MAX_RESULTS])
    : await db.execute(
        `SELECT n.id, n.external_id, n.level, COALESCE(tr.label, n.label) AS label
         FROM nodes n
         LEFT JOIN node_translations tr ON tr.node_external_id = n.external_id AND tr.locale = ?
         WHERE n.is_active = 1 AND COALESCE(tr.label, n.label) LIKE ?
         ORDER BY n.level ASC, LENGTH(COALESCE(tr.label, n.label)) ASC LIMIT ?`,
        [locale, pattern, MAX_RESULTS]);

  if (!matches.length) return `No map topics found matching "${term}".`;

  // One recursive query gets every ancestor id (self included) for every
  // match, tagged by root_id — cheaper than one ancestor walk per match.
  const ids = matches.map(m => m.id);
  const placeholders = ids.map(() => '?').join(',');
  const [chain] = await db.execute(
    `WITH RECURSIVE anc AS (
       SELECT id, external_id, parent_id, level, id AS root_id FROM nodes WHERE id IN (${placeholders})
       UNION ALL
       SELECT n.id, n.external_id, n.parent_id, n.level, a.root_id
       FROM nodes n JOIN anc a ON n.id = a.parent_id
     )
     SELECT root_id, id, external_id, level FROM anc ORDER BY root_id, level`,
    ids
  );

  // Resolve labels (locale-aware) for every node appearing anywhere in any chain.
  const allExternalIds = [...new Set(chain.map(c => c.external_id))];
  const idPlaceholders = allExternalIds.map(() => '?').join(',');
  const [labelRows] = locale === 'en'
    ? await db.execute(
        `SELECT external_id, label FROM nodes WHERE external_id IN (${idPlaceholders})`,
        allExternalIds)
    : await db.execute(
        `SELECT n.external_id, COALESCE(tr.label, n.label) AS label
         FROM nodes n
         LEFT JOIN node_translations tr ON tr.node_external_id = n.external_id AND tr.locale = ?
         WHERE n.external_id IN (${idPlaceholders})`,
        [locale, ...allExternalIds]);
  const labelOf = {};
  labelRows.forEach(r => { labelOf[r.external_id] = r.label; });

  const childCountOf = await _childCounts(matches.map(m => m.id));

  const byRoot = {};
  chain.forEach(c => { (byRoot[c.root_id] = byRoot[c.root_id] || []).push(c); });

  const lines = matches.map(m => {
    const links = (byRoot[m.id] || []).sort((a, b) => a.level - b.level);
    const breadcrumb = links.map(l => labelOf[l.external_id]).filter(Boolean).join(' > ');
    const n = childCountOf[m.id] || 0;
    const childNote = n > 0 ? ` — has ${n} direct child node${n === 1 ? '' : 's'} (call list_map_children with node_id "${m.external_id}" to see them)` : '';
    return `- [L${m.level}] node_id:${m.external_id} ${breadcrumb || m.label}${childNote}`;
  });

  return `Found ${matches.length} matching map topic(s):\n${lines.join('\n')}`;
}

// Direct children of one specific node, in curriculum order (creation order —
// the map has no separate sibling-ordering field, and id order matches how
// the curriculum was originally authored). This is the piece search_map
// alone can't give: a text search only ever finds nodes whose OWN label
// matches the query, never a node's children — asking "what order should I
// learn the L5s under Sound change" needs an actual parent->children lookup,
// not another keyword search.
async function listMapChildren(nodeId, locale) {
  const externalId = (nodeId || '').toString().trim();
  if (!externalId) return 'No node_id given.';

  const [parentRows] = locale === 'en'
    ? await db.execute(`SELECT id, level, label FROM nodes WHERE external_id = ? AND is_active = 1`, [externalId])
    : await db.execute(
        `SELECT n.id, n.level, COALESCE(tr.label, n.label) AS label
         FROM nodes n
         LEFT JOIN node_translations tr ON tr.node_external_id = n.external_id AND tr.locale = ?
         WHERE n.external_id = ? AND n.is_active = 1`,
        [locale, externalId]);
  if (!parentRows.length) return `No active map node found with node_id "${externalId}".`;
  const parent = parentRows[0];

  const [children] = locale === 'en'
    ? await db.execute(
        `SELECT id, external_id, level, label FROM nodes
         WHERE parent_id = ? AND is_active = 1 ORDER BY id ASC`,
        [parent.id])
    : await db.execute(
        `SELECT n.id, n.external_id, n.level, COALESCE(tr.label, n.label) AS label
         FROM nodes n
         LEFT JOIN node_translations tr ON tr.node_external_id = n.external_id AND tr.locale = ?
         WHERE n.parent_id = ? AND n.is_active = 1 ORDER BY n.id ASC`,
        [locale, parent.id]);
  if (!children.length) return `"${parent.label}" (L${parent.level}) has no child nodes — it's a leaf.`;

  const grandchildCounts = await _childCounts(children.map(c => c.id));
  const lines = children.map((c, i) => {
    const n = grandchildCounts[c.id] || 0;
    const note = n > 0 ? ` — has ${n} child node${n === 1 ? '' : 's'} of its own` : '';
    return `${i + 1}. [L${c.level}] node_id:${c.external_id} ${c.label}${note}`;
  });

  return `"${parent.label}" (L${parent.level}) has ${children.length} direct child node(s), in curriculum order:\n${lines.join('\n')}`;
}

module.exports = { searchMapNodes, listMapChildren };
