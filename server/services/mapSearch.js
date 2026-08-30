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

async function searchMapNodes(query, locale) {
  const term = (query || '').trim();
  if (!term) return 'No search term given.';
  const pattern = `%${_escapeLike(term)}%`;

  const [matches] = locale === 'en'
    ? await db.execute(
        `SELECT id, level, label FROM nodes
         WHERE is_active = 1 AND label LIKE ?
         ORDER BY level ASC, LENGTH(label) ASC LIMIT ?`,
        [pattern, MAX_RESULTS])
    : await db.execute(
        `SELECT n.id, n.level, COALESCE(tr.label, n.label) AS label
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

  const byRoot = {};
  chain.forEach(c => { (byRoot[c.root_id] = byRoot[c.root_id] || []).push(c); });

  const lines = matches.map(m => {
    const links = (byRoot[m.id] || []).sort((a, b) => a.level - b.level);
    const breadcrumb = links.map(l => labelOf[l.external_id]).filter(Boolean).join(' > ');
    return `- [L${m.level}] ${breadcrumb || m.label}`;
  });

  return `Found ${matches.length} matching map topic(s):\n${lines.join('\n')}`;
}

module.exports = { searchMapNodes };
