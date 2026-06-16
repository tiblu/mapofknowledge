/* ═══════════════════════════════════════════════════════════════
   SUBSETS — /api/subsets
   Custom knowledge map filters. Personal for all users; public
   requires admin promotion.
   ═══════════════════════════════════════════════════════════════ */

const express        = require('express');
const router         = express.Router();
const db             = require('../db');
const { matchTerms } = require('../services/subsetMatcher');

const ADMIN_ROLES = new Set(['admin', 'super_admin']);
const isAdmin = (user) => ADMIN_ROLES.has(user?.role);

// ── Sample file downloads ─────────────────────────────────────────────────────
// These routes must come before /:id to avoid conflicts.

router.get('/sample/json', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="knowledge-map-sample.json"');
  res.json({
    name: 'My Custom Map',
    description: 'Optional description of what this map covers',
    version: '2024',
    source_url: 'https://example.com/curriculum.pdf',
    icon_color: 'sage',
    nodes: [
      {
        label: 'Algebra',
        breadcrumb: 'Mathematics',
        note: 'Anchors at L3 — includes all algebra subtopics'
      },
      {
        label: 'Estonian language',
        breadcrumb: 'Linguistics > Philology > Uralic languages > Finno-Ugric languages',
        note: 'Anchors at L5 — only Estonian, not the full Uralic family'
      },
      {
        label: 'Information security',
        breadcrumb: 'Computer science',
        note: 'Anchors at L3 — includes cryptography, IAM, etc.'
      },
      {
        label: 'Classical mechanics',
        breadcrumb: 'Natural sciences > Physics',
        note: 'Anchors at L3 — includes kinematics, dynamics, thermodynamics'
      }
    ]
  });
});

router.get('/sample/csv', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="knowledge-map-sample.csv"');
  res.setHeader('Content-Type', 'text/csv');
  res.send([
    'label,breadcrumb,note',
    'Algebra,Mathematics,Anchors at L3 — includes all algebra subtopics',
    'Estonian language,Linguistics > Philology > Uralic languages > Finno-Ugric languages,Anchors at L5 — only Estonian',
    'Information security,Computer science,Anchors at L3',
    'Classical mechanics,Natural sciences > Physics,Anchors at L3',
  ].join('\r\n'));
});

// ── List subsets visible to current user ──────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const userId = req.user.id;
    const [rows] = await db.execute(
      `SELECT s.id, s.name, s.description, s.icon_color, s.type, s.created_by,
              s.version, s.source_url,
              s.background_hidden, s.display_mode, s.is_overlay, s.ring_color,
              (SELECT COUNT(*) FROM knowledge_subset_nodes ksn WHERE ksn.subset_id = s.id) AS node_count
       FROM knowledge_subsets s
       WHERE s.is_active = 1
         AND (s.type = 'public' OR s.created_by = ?)
       ORDER BY s.type DESC, s.name ASC`,
      [userId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[subsets GET /]', err.message);
    res.status(500).json({ error: 'Failed to load subsets' });
  }
});

// ── Get node labels for a subset (used by filter panel) ──────────────────────
router.get('/:id/nodes', async (req, res) => {
  try {
    let locale = 'en';
    if (req.user?.id) {
      const [ls] = await db.execute(
        "SELECT value FROM user_settings WHERE user_id = ? AND key_name = 'ui_locale'",
        [req.user.id]
      );
      if (ls.length && ls[0].value) locale = ls[0].value;
    }

    const [rows] = locale === 'en'
      ? await db.execute(
          `SELECT n.label FROM knowledge_subset_nodes ksn
           JOIN nodes n ON ksn.node_id = n.id
           WHERE ksn.subset_id = ?`,
          [req.params.id]
        )
      : await db.execute(
          `SELECT COALESCE(tr.label, n.label) AS label
           FROM knowledge_subset_nodes ksn
           JOIN nodes n ON ksn.node_id = n.id
           LEFT JOIN node_translations tr
             ON tr.node_external_id = n.external_id AND tr.locale = ?
           WHERE ksn.subset_id = ?`,
          [locale, req.params.id]
        );

    res.json(rows.map(r => r.label));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load subset nodes' });
  }
});

// ── Get staging rows for a subset ────────────────────────────────────────────
router.get('/:id/staging', async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT s.id, s.input_term, s.input_breadcrumb, s.matched_node_id,
              s.match_method, s.confidence, s.status, s.candidates_json,
              n.label AS node_label, n.level AS node_level
       FROM subset_import_staging s
       LEFT JOIN nodes n ON n.id = s.matched_node_id
       WHERE s.subset_id = ?
       ORDER BY s.id ASC`,
      [req.params.id]
    );
    // Attach breadcrumb for matched nodes
    const enriched = await _attachBreadcrumbs(rows);
    res.json(enriched);
  } catch (err) {
    console.error('[subsets GET staging]', err.message);
    res.status(500).json({ error: 'Failed to load staging' });
  }
});

// ── Create a new subset ───────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { name, description, icon_color } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  try {
    const [result] = await db.execute(
      `INSERT INTO knowledge_subsets (name, description, icon_color, type, created_by)
       VALUES (?, ?, ?, 'personal', ?)`,
      [name.trim(), description || null, icon_color || 'terra', req.user.id]
    );
    res.json({ id: result.insertId, name: name.trim(), icon_color: icon_color || 'terra', type: 'personal' });
  } catch (err) {
    console.error('[subsets POST /]', err.message);
    res.status(500).json({ error: 'Failed to create subset' });
  }
});

// ── Import: run matching pipeline, store + return staging rows ───────────────
router.post('/:id/import', async (req, res) => {
  const subsetId = parseInt(req.params.id);
  const { terms } = req.body; // [{ label, breadcrumb? }]
  if (!Array.isArray(terms) || !terms.length) {
    return res.status(400).json({ error: 'terms array required' });
  }

  // Verify ownership
  const [subs] = await db.execute(
    'SELECT created_by FROM knowledge_subsets WHERE id = ? AND is_active = 1', [subsetId]
  );
  if (!subs.length || (subs[0].created_by !== req.user.id && !isAdmin(req.user))) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  try {
    // Clear any previous staging for this subset
    await db.execute('DELETE FROM subset_import_staging WHERE subset_id = ?', [subsetId]);

    const staged = await matchTerms(terms, db);

    // Insert staging rows
    for (const row of staged) {
      await db.execute(
        `INSERT INTO subset_import_staging
           (subset_id, input_term, input_breadcrumb, matched_node_id,
            match_method, confidence, status, candidates_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [subsetId, row.input_term, row.input_breadcrumb, row.matched_node_id,
         row.match_method, row.confidence, row.status, row.candidates_json]
      );
    }

    // Re-fetch with node labels + breadcrumbs for the response
    const [rows] = await db.execute(
      `SELECT s.id, s.input_term, s.input_breadcrumb, s.matched_node_id,
              s.match_method, s.confidence, s.status, s.candidates_json,
              n.label AS node_label, n.level AS node_level
       FROM subset_import_staging s
       LEFT JOIN nodes n ON n.id = s.matched_node_id
       WHERE s.subset_id = ? ORDER BY s.id ASC`,
      [subsetId]
    );
    const enriched = await _attachBreadcrumbs(rows);
    res.json({ stagingRows: enriched });
  } catch (err) {
    console.error('[subsets POST import]', err.message);
    res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

// ── Commit: write accepted node IDs to subset_nodes ──────────────────────────
router.post('/:id/commit', async (req, res) => {
  const subsetId = parseInt(req.params.id);
  const { nodeIds, makePublic } = req.body; // nodeIds: number[]
  if (!Array.isArray(nodeIds)) return res.status(400).json({ error: 'nodeIds array required' });

  const [subs] = await db.execute(
    'SELECT created_by, type FROM knowledge_subsets WHERE id = ? AND is_active = 1', [subsetId]
  );
  if (!subs.length || (subs[0].created_by !== req.user.id && !isAdmin(req.user))) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  try {
    // Replace existing nodes
    await db.execute('DELETE FROM knowledge_subset_nodes WHERE subset_id = ?', [subsetId]);
    for (const nodeId of nodeIds) {
      await db.execute(
        'INSERT IGNORE INTO knowledge_subset_nodes (subset_id, node_id) VALUES (?, ?)',
        [subsetId, nodeId]
      );
    }

    // Promote to public (admin only)
    if (makePublic && isAdmin(req.user)) {
      await db.execute(
        "UPDATE knowledge_subsets SET type = 'public' WHERE id = ?", [subsetId]
      );
    }

    // Clean up staging
    await db.execute('DELETE FROM subset_import_staging WHERE subset_id = ?', [subsetId]);

    res.json({ ok: true, nodeCount: nodeIds.length });
  } catch (err) {
    console.error('[subsets POST commit]', err.message);
    res.status(500).json({ error: 'Commit failed' });
  }
});

// ── Update filter display settings ───────────────────────────────────────────
router.patch('/:id/settings', async (req, res) => {
  const subsetId = parseInt(req.params.id);
  const [subs] = await db.execute(
    'SELECT created_by FROM knowledge_subsets WHERE id = ? AND is_active = 1', [subsetId]
  );
  if (!subs.length || (subs[0].created_by !== req.user.id && !isAdmin(req.user))) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  const { background_hidden, display_mode, is_overlay, ring_color } = req.body;
  const updates = [];
  const vals    = [];
  if (background_hidden !== undefined) { updates.push('background_hidden = ?'); vals.push(background_hidden ? 1 : 0); }
  if (display_mode      !== undefined) { updates.push('display_mode = ?');      vals.push(display_mode); }
  if (is_overlay        !== undefined) { updates.push('is_overlay = ?');        vals.push(is_overlay ? 1 : 0); }
  if (ring_color        !== undefined) { updates.push('ring_color = ?');        vals.push(ring_color); }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  try {
    vals.push(subsetId);
    await db.execute(`UPDATE knowledge_subsets SET ${updates.join(', ')} WHERE id = ?`, vals);
    res.json({ ok: true });
  } catch (err) {
    console.error('[subsets PATCH settings]', err.message);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ── Toggle public (admin only) ────────────────────────────────────────────────
router.patch('/:id/publish', async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin only' });
  const { publish } = req.body;
  try {
    await db.execute(
      "UPDATE knowledge_subsets SET type = ? WHERE id = ?",
      [publish ? 'public' : 'personal', req.params.id]
    );

    // Notify all users when a map is made public
    if (publish) {
      const [[subset]] = await db.execute(
        'SELECT name FROM knowledge_subsets WHERE id = ?', [req.params.id]
      );
      if (subset) {
        const [users] = await db.execute('SELECT id FROM users');
        if (users.length) {
          const title = `New map filter available: ${subset.name}`;
          const body  = `The "${subset.name}" knowledge map filter has been added. Activate it in the filter panel on the map.`;
          const ph    = users.map(() => '(?,?,?,?,?)').join(',');
          const vals  = users.flatMap(u => [u.id, 'admin', title, body, 'lavender']);
          await db.execute(
            `INSERT INTO notifications (user_id, type, title, body, icon_color) VALUES ${ph}`,
            vals
          );
        }
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[subsets PATCH publish]', err.message);
    res.status(500).json({ error: 'Failed to update' });
  }
});

// ── Delete a subset ───────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  const [subs] = await db.execute(
    'SELECT created_by FROM knowledge_subsets WHERE id = ?', [req.params.id]
  );
  if (!subs.length || (subs[0].created_by !== req.user.id && !isAdmin(req.user))) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  try {
    await db.execute('UPDATE knowledge_subsets SET is_active = 0 WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete' });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
async function _attachBreadcrumbs(rows) {
  const nodeIds = [...new Set(rows.map(r => r.matched_node_id).filter(Boolean))];
  if (!nodeIds.length) return rows;

  const breadcrumbMap = {};
  for (const nodeId of nodeIds) {
    const [anc] = await db.execute(
      `WITH RECURSIVE anc AS (
         SELECT id, label, level, parent_id FROM nodes WHERE id = ?
         UNION ALL
         SELECT n.id, n.label, n.level, n.parent_id FROM nodes n JOIN anc a ON n.id = a.parent_id
       )
       SELECT label FROM anc ORDER BY level ASC`,
      [nodeId]
    );
    breadcrumbMap[nodeId] = anc.map(a => a.label).join(' › ');
  }

  return rows.map(r => ({
    ...r,
    node_breadcrumb: r.matched_node_id ? breadcrumbMap[r.matched_node_id] : null,
    candidates: r.candidates_json ? JSON.parse(r.candidates_json) : [],
  }));
}

module.exports = router;
