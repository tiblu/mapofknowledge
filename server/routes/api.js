const express = require('express');
const router  = express.Router();
const db      = require('../db');
const llm     = require('../services/llm');
const game    = require('../services/game');
const { notify, getUserLocale } = require('../services/notifications');
const { buildKnobitDocx } = require('../services/knobitDocx');
const { renderPassportText } = require('../services/passportText');
const { redeemLinkCode, sendChildInvite, acceptChildInvite, generateCode } = require('../services/links');
const testlog = require('../testlog'); // TESTLOG

// ── User profile helper ──────────────────────────────────────────────────────
async function getUserProfile(userId) {
  if (!userId) return null;
  try {
    const [users] = await db.execute('SELECT passport_id FROM users WHERE id = ?', [userId]);
    if (!users.length || !users[0].passport_id) return null;
    const passportId = users[0].passport_id;
    const [[passport]] = await db.execute(
      'SELECT birth_year, location, cultural_background, about FROM learner_passports WHERE id = ?',
      [passportId]
    );
    const [tags] = await db.execute(
      'SELECT type, text FROM passport_tags WHERE passport_id = ? ORDER BY sort_order',
      [passportId]
    );
    return {
      birth_year:          passport?.birth_year || null,
      location:            passport?.location   || null,
      cultural_background: passport?.cultural_background || null,
      about:               passport?.about      || null,
      interests: tags.filter(t => t.type === 'interest').map(t => t.text),
      values:    tags.filter(t => t.type === 'value').map(t => t.text),
    };
  } catch { return null; }
}

// ── Full Learner Passport helper — shared by GET /profile and Anne's chat context ──
async function _fetchFullPassport(passportId, locale) {
  const [[passport]] = await db.execute(
    'SELECT * FROM learner_passports WHERE id = ?', [passportId]
  );

  const [credentials] = await db.execute(
    `SELECT * FROM passport_credentials WHERE passport_id = ? ORDER BY awarded_date DESC, id DESC`,
    [passportId]
  );

  const [competence] = await db.execute(
    `SELECT * FROM passport_competence WHERE passport_id = ? ORDER BY type, sort_order`,
    [passportId]
  );

  // L4/L5 knowledge nodes with full breadcrumb (locale-aware labels)
  const [mapKnowledgeRaw] = await db.execute(
    `SELECT COALESCE(tr_n.label,  n.label)  AS label,  n.level, u.percentage, u.source,
            COALESCE(tr_p1.label, p1.label) AS p1,
            COALESCE(tr_p2.label, p2.label) AS p2,
            COALESCE(tr_p3.label, p3.label) AS p3,
            COALESCE(tr_p4.label, p4.label) AS p4
     FROM user_node_knowledge u
     JOIN nodes n ON n.external_id = u.node_external_id
     LEFT JOIN node_translations tr_n  ON tr_n.node_external_id  = n.external_id  AND tr_n.locale  = ?
     LEFT JOIN nodes p1 ON p1.id = n.parent_id
     LEFT JOIN node_translations tr_p1 ON tr_p1.node_external_id = p1.external_id AND tr_p1.locale = ?
     LEFT JOIN nodes p2 ON p2.id = p1.parent_id
     LEFT JOIN node_translations tr_p2 ON tr_p2.node_external_id = p2.external_id AND tr_p2.locale = ?
     LEFT JOIN nodes p3 ON p3.id = p2.parent_id
     LEFT JOIN node_translations tr_p3 ON tr_p3.node_external_id = p3.external_id AND tr_p3.locale = ?
     LEFT JOIN nodes p4 ON p4.id = p3.parent_id
     LEFT JOIN node_translations tr_p4 ON tr_p4.node_external_id = p4.external_id AND tr_p4.locale = ?
     WHERE u.passport_id = ? AND n.level IN (4,5) AND u.percentage > 0
     ORDER BY u.percentage DESC, n.level DESC
     LIMIT 200`,
    [locale, locale, locale, locale, locale, passportId]
  );
  const mapKnowledge = mapKnowledgeRaw.map(r => ({
    label:      r.label,
    level:      r.level,
    percentage: r.percentage,
    source:     r.source,
    breadcrumb: [r.p4, r.p3, r.p2, r.p1].filter(Boolean).join(' › '),
  }));

  const [events] = await db.execute(
    `SELECT * FROM passport_events WHERE passport_id = ? ORDER BY event_date DESC, id DESC`,
    [passportId]
  );

  const [tags] = await db.execute(
    'SELECT * FROM passport_tags WHERE passport_id = ? ORDER BY sort_order',
    [passportId]
  );

  const [relationships] = await db.execute(
    `SELECT * FROM passport_relationships WHERE passport_id = ? ORDER BY type, sort_order, id`,
    [passportId]
  );

  const [reflections] = await db.execute(
    `SELECT r.id, r.text, r.created_at,
            e.id AS event_id, e.title AS event_title, e.event_date
     FROM passport_reflections r
     LEFT JOIN passport_events e ON r.event_id = e.id
     WHERE r.passport_id = ?
     ORDER BY r.created_at DESC`,
    [passportId]
  );

  const [learningStyle] = await db.execute(
    'SELECT * FROM passport_learning_style WHERE passport_id = ?',
    [passportId]
  );

  const [goalsRaw] = await db.execute(
    `SELECT g.*,
            n.label AS node_label,
            COALESCE(unk.percentage, 0) AS progress,
            (SELECT COUNT(*) FROM knobits k WHERE k.node_id = n.id) AS knobit_total,
            (SELECT COUNT(*) FROM knobit_progress kp
             JOIN knobits k2 ON k2.id = kp.knobit_id
             WHERE k2.node_id = n.id AND kp.passport_id = g.passport_id
               AND kp.phase_reached = 'done') AS knobit_done
     FROM passport_goals g
     LEFT JOIN nodes n ON n.external_id = g.node_external_id
     LEFT JOIN user_node_knowledge unk
       ON unk.node_external_id = g.node_external_id AND unk.passport_id = g.passport_id
     WHERE g.passport_id = ?
     ORDER BY g.status ASC, g.created_at DESC`,
    [passportId]
  );
  const goals = goalsRaw.map(g => ({
    ...g,
    eta_minutes: g.node_external_id
      ? Math.max(0, (Number(g.knobit_total) || 4) - (Number(g.knobit_done) || 0)) * 8
      : null,
  }));

  const [aspirations] = await db.execute(
    'SELECT * FROM passport_aspirations WHERE passport_id = ? ORDER BY sort_order',
    [passportId]
  );

  const [objectives] = await db.execute(
    'SELECT * FROM passport_objectives WHERE passport_id = ? ORDER BY sort_order',
    [passportId]
  );

  const [plans] = await db.execute(
    'SELECT * FROM passport_plans WHERE passport_id = ? ORDER BY sort_order',
    [passportId]
  );

  return {
    passport,
    credentials,
    competence,
    mapKnowledge,
    events,
    tags,
    relationships,
    reflections,
    learningStyle: learningStyle[0] || null,
    goals,
    aspirations,
    objectives,
    plans,
  };
}

// ── In-memory map cache per locale (10k+ nodes — cache after first DB load) ───
const mapCaches = {};

router.get('/map', async (req, res) => {
  try {
    const locale = await getUserLocale(req.user?.id);
    if (mapCaches[locale]) return res.json(mapCaches[locale]);

    const [nodes] = locale === 'en'
      ? await db.execute(
          `SELECT external_id AS id, label, level FROM nodes WHERE layer = 'foundational' AND is_active = 1`)
      : await db.execute(
          `SELECT n.external_id AS id, COALESCE(tr.label, n.label) AS label, n.level
           FROM nodes n
           LEFT JOIN node_translations tr
             ON tr.node_external_id = n.external_id AND tr.locale = ?
           WHERE n.layer = 'foundational' AND n.is_active = 1`, [locale]);

    const [edges] = await db.execute(
      `SELECT s.external_id AS source, t.external_id AS target
       FROM edges e
       JOIN nodes s ON e.source_node_id = s.id
       JOIN nodes t ON e.target_node_id = t.id
       WHERE e.edge_type = 'hierarchy'`
    );

    mapCaches[locale] = { nodes, edges };
    res.json(mapCaches[locale]);
  } catch (err) {
    console.error('[api/map]', err.message);
    res.status(500).json({ error: 'Failed to load map data' });
  }
});

// Bust cache when migration reruns or translations are updated
router.post('/map/bust-cache', (req, res) => {
  Object.keys(mapCaches).forEach(k => delete mapCaches[k]);
  res.json({ ok: true });
});

// ── Node overview (generate once, cache in DB) ───────────────────────────────
router.get('/nodes/:id/overview', async (req, res) => {
  const { id } = req.params;
  try {
    const [rows] = await db.execute(
      'SELECT id AS db_id, label, level, overview FROM nodes WHERE external_id = ?', [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Node not found' });
    const node = rows[0];

    const locale = await getUserLocale(req.user?.id);

    if (locale === 'en') {
      if (node.overview) return res.json({ overview: node.overview });
    } else {
      const [cached] = await db.execute(
        'SELECT overview FROM node_overview_translations WHERE node_external_id = ? AND locale = ?',
        [id, locale]
      );
      if (cached.length) return res.json({ overview: cached[0].overview });
    }

    const domain = await getNodeDomain(node.db_id);
    let overview = await llm.generateOverview(node.label, domain, node.level, locale, req.user?.id);
    if (locale === 'en') {
      await db.execute('UPDATE nodes SET overview = ? WHERE external_id = ?', [overview, id]);
    } else {
      ({ overview } = await llm.editTranslatedText({ overview }, locale, req.user?.id));
      await db.execute(
        `INSERT INTO node_overview_translations (node_external_id, locale, overview) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE overview = VALUES(overview)`,
        [id, locale, overview]
      );
    }
    res.json({ overview });
  } catch (err) {
    console.error('[api/nodes/overview]', err.message);
    res.status(500).json({ error: 'Failed to generate overview' });
  }
});

// ── L2 -> L3 recommended learning order (cached; LLM decides order only) ────
router.get('/nodes/:id/child-order', async (req, res) => {
  const { id } = req.params;
  try {
    const [nodes] = await db.execute('SELECT id AS db_id FROM nodes WHERE external_id = ?', [id]);
    if (!nodes.length) return res.status(404).json({ error: 'Node not found' });
    const { db_id } = nodes[0];
    const locale = await getUserLocale(req.user?.id);

    const [cached] = locale === 'en'
      ? await db.execute(
          `SELECT c.external_id AS id, c.label
           FROM node_child_order o JOIN nodes c ON c.id = o.child_node_id
           WHERE o.parent_node_id = ? ORDER BY o.position ASC`,
          [db_id])
      : await db.execute(
          `SELECT c.external_id AS id, COALESCE(tr.label, c.label) AS label
           FROM node_child_order o
           JOIN nodes c ON c.id = o.child_node_id
           LEFT JOIN node_translations tr ON tr.node_external_id = c.external_id AND tr.locale = ?
           WHERE o.parent_node_id = ? ORDER BY o.position ASC`,
          [locale, db_id]);
    if (cached.length) return res.json({ order: cached });

    // Ordering is decided once per node (locale-independent — pedagogical order
    // doesn't change per language), using the canonical English label.
    const [children] = await db.execute(
      'SELECT id AS db_id, external_id, label FROM nodes WHERE parent_id = ? AND is_active = 1 ORDER BY id ASC',
      [db_id]
    );
    if (!children.length) return res.json({ order: [] });

    const positions = children.length > 1
      ? await llm.generateChildOrder(children.map(c => c.label), req.user?.id)
      : [1];
    const ordered = positions.map(pos => children[pos - 1]);

    await Promise.all(ordered.map((c, i) =>
      db.execute(
        `INSERT INTO node_child_order (parent_node_id, child_node_id, position) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE position = VALUES(position)`,
        [db_id, c.db_id, i + 1]
      )
    ));

    if (locale === 'en') {
      return res.json({ order: ordered.map(c => ({ id: c.external_id, label: c.label })) });
    }
    const [trRows] = await db.execute(
      `SELECT node_external_id, label FROM node_translations WHERE locale = ? AND node_external_id IN (${ordered.map(() => '?').join(',')})`,
      [locale, ...ordered.map(c => c.external_id)]
    );
    const trMap = new Map(trRows.map(r => [r.node_external_id, r.label]));
    res.json({ order: ordered.map(c => ({ id: c.external_id, label: trMap.get(c.external_id) || c.label })) });
  } catch (err) {
    console.error('[api/nodes/child-order]', err.message);
    res.status(500).json({ error: 'Failed to get child order' });
  }
});

// ── User settings ────────────────────────────────────────────────────────────
router.get('/settings', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.json({});
  try {
    const [rows] = await db.execute(
      'SELECT key_name, value FROM user_settings WHERE user_id = ?', [userId]
    );
    const out = {};
    rows.forEach(r => { out[r.key_name] = r.value; });
    if (!out.ui_locale) out.ui_locale = 'et'; // new users default to Estonian
    res.json(out);
  } catch (err) {
    res.json({});
  }
});

router.post('/settings', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(400).json({ error: 'Not authenticated' });
  const { key, value } = req.body;
  if (!key || value === undefined) return res.status(400).json({ error: 'key and value required' });
  try {
    await db.execute(
      `INSERT INTO user_settings (user_id, key_name, value) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value)`,
      [userId, key, value]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[api/settings POST]', err.message);
    res.status(500).json({ error: 'Failed to save setting' });
  }
});

// ── UI strings (i18n) ────────────────────────────────────────────────────────
// Queried fresh every request — no server-side cache. This table used to be
// cached in-process with no invalidation, which meant any string added or
// edited directly in the DB (the normal way this project ships new i18n
// keys) silently didn't show up until the server next happened to restart.
// The Cache-Control header below still lets browsers avoid refetching within
// a session; that's the caching layer that actually matters here.
// Falls back to 'en' for any keys missing in the requested locale.
router.get('/strings', async (req, res) => {
  const locale = (req.query.locale || 'en').replace(/[^a-zA-Z-]/g, '').slice(0, 10) || 'en';
  try {
    const [rows] = await db.execute(
      'SELECT key_name, value FROM ui_strings WHERE locale = ?', [locale]
    );
    const out = {};
    rows.forEach(r => { out[r.key_name] = r.value; });
    // Fill missing keys from English fallback
    if (locale !== 'en') {
      const [enRows] = await db.execute(
        'SELECT key_name, value FROM ui_strings WHERE locale = ?', ['en']
      );
      enRows.forEach(r => { if (out[r.key_name] === undefined) out[r.key_name] = r.value; });
    }
    res.set('Cache-Control', 'public, max-age=300').json(out);
  } catch (err) {
    console.error('[api/strings]', err.message);
    res.json({});
  }
});

// ── Most recent in-progress learning path ────────────────────────────────────
router.get('/learn/resume', async (req, res) => {
  const passportId = req.user?.passport_id;
  if (!passportId) return res.json({});

  try {
    const locale = await getUserLocale(req.user?.id);
    const [rows] = await db.execute(
      `SELECT n.external_id AS nodeId, COALESCE(tr.label, n.label) AS label,
              COUNT(k.id)          AS total,
              COUNT(kp.knobit_id)  AS done,
              MAX(kp.completed_at) AS last_activity
       FROM knobits k
       JOIN nodes n ON k.node_id = n.id
       LEFT JOIN node_translations tr ON tr.node_external_id = n.external_id AND tr.locale = ?
       LEFT JOIN knobit_progress kp
              ON k.id = kp.knobit_id AND kp.passport_id = ?
       GROUP BY n.id, n.external_id, n.label, tr.label
       HAVING done > 0 AND done < total
       ORDER BY last_activity DESC
       LIMIT 1`,
      [locale, passportId]
    );
    res.json(rows.length ? rows[0] : {});
  } catch (err) {
    console.error('[api/learn/resume]', err.message);
    res.json({});
  }
});

// ── Knobit progress for current user ─────────────────────────────────────────
router.get('/nodes/:id/learn-progress', async (req, res) => {
  const { id }      = req.params;
  const passportId  = req.user?.passport_id;
  if (!passportId) return res.json({ done: 0, total: 0 });

  try {
    const [nodes] = await db.execute(
      'SELECT id AS db_id FROM nodes WHERE external_id = ?', [id]
    );
    if (!nodes.length) return res.json({ done: 0, total: 0 });
    const locale = await getUserLocale(req.user?.id);

    const [[{ total }]] = await db.execute(
      'SELECT COUNT(*) AS total FROM knobits WHERE node_id = ? AND locale = ?',
      [nodes[0].db_id, locale]
    );
    if (!total) return res.json({ done: 0, total: 0 });

    const [[{ done }]] = await db.execute(
      `SELECT COUNT(*) AS done
       FROM knobit_progress kp
       JOIN knobits k ON kp.knobit_id = k.id
       WHERE kp.passport_id = ? AND k.node_id = ? AND k.locale = ? AND kp.phase_reached = 'done'`,
      [passportId, nodes[0].db_id, locale]
    );

    res.json({ done, total });
  } catch (err) {
    res.json({ done: 0, total: 0 });
  }
});

// ── Whether the current user already has this node as an active goal ────────
router.get('/nodes/:id/goal-status', async (req, res) => {
  const { id }     = req.params;
  const passportId = req.user?.passport_id;
  if (!passportId) return res.json({ hasGoal: false });

  try {
    const [rows] = await db.execute(
      `SELECT id FROM passport_goals WHERE passport_id = ? AND node_external_id = ? AND status = 'in_progress'`,
      [passportId, id]
    );
    res.json({ hasGoal: rows.length > 0 });
  } catch (err) {
    res.json({ hasGoal: false });
  }
});

// ── User knowledge percentage ────────────────────────────────────────────────
router.get('/nodes/:id/knowledge', async (req, res) => {
  const { id }      = req.params;
  const passportId  = req.user?.passport_id;
  if (!passportId) return res.json({ percentage: 0, source: null });

  try {
    const [rows] = await db.execute(
      `SELECT percentage, source
       FROM user_node_knowledge WHERE passport_id = ? AND node_external_id = ?`,
      [passportId, id]
    );
    res.json(rows.length ? rows[0] : { percentage: 0, source: null });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get knowledge' });
  }
});

router.post('/nodes/:id/knowledge', async (req, res) => {
  const { id }                          = req.params;
  const { percentage, source = 'self_reported' } = req.body;
  const passportId                      = req.user?.passport_id;
  if (!passportId) return res.status(400).json({ error: 'No passport linked to account' });

  try {
    const locale = await getUserLocale(req.user?.id);
    const [nodes] = await db.execute(
      `SELECT n.id AS db_id, n.level, n.label, COALESCE(tr.label, n.label) AS display_label
       FROM nodes n
       LEFT JOIN node_translations tr ON tr.node_external_id = n.external_id AND tr.locale = ?
       WHERE n.external_id = ?`, [locale, id]
    );
    if (!nodes.length) return res.status(404).json({ error: 'Node not found' });
    const { db_id, level, display_label } = nodes[0];

    await db.execute(
      `INSERT INTO user_node_knowledge
         (passport_id, node_external_id, percentage, source, updated_at)
       VALUES (?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         percentage = VALUES(percentage),
         source = VALUES(source),
         updated_at = NOW()`,
      [passportId, id, percentage, source]
    );

    // Cascade to L5 children server-side to avoid client race condition
    if (level === 4) {
      const [children] = await db.execute(
        'SELECT external_id FROM nodes WHERE parent_id = ? AND level = 5',
        [db_id]
      );
      for (const child of children) {
        await db.execute(
          `INSERT INTO user_node_knowledge
             (passport_id, node_external_id, percentage, source, updated_at)
           VALUES (?, ?, ?, ?, NOW())
           ON DUPLICATE KEY UPDATE
             percentage = VALUES(percentage), source = VALUES(source), updated_at = NOW()`,
          [passportId, child.external_id, percentage, source]
        );
      }
    }

    // Single ancestor update after all writes are done
    updateAncestorKnowledge(passportId, id).catch(() => {});

    // Log mark / unmark as known events
    if (source === 'self_reported' && passportId) {
      const pct = parseInt(percentage);
      const eventTitle = pct >= 100
        ? (locale === 'et' ? `Märgitud teadaolevaks: ${display_label}` : `Marked as known: ${display_label}`)
        : (locale === 'et' ? `Eemaldati teadaolevate hulgast: ${display_label}` : `Unmarked as known: ${display_label}`);
      db.execute(
        `INSERT INTO passport_events (passport_id, event_date, title, institution, node_external_id, type, sort_order)
         VALUES (?, CURDATE(), ?, 'KnoBitz platvorm', ?, 'activity', 0)`,
        [passportId, eventTitle, id]
      ).catch(() => {});
      if (pct >= 100) {
        notify(req.user?.id, 'knowledge_marked',
          locale === 'et' ? `Märgitud teadaolevaks: ${display_label}` : `Marked as known: ${display_label}`,
          locale === 'et' ? 'Lisatud sinu õppija passi teadmiste kaardile.' : 'Added to your Learner Passport knowledge map.', id);
      }
    }

    res.json({ ok: true, percentage, source });
  } catch (err) {
    console.error('[api/nodes/knowledge POST]', err.message);
    res.status(500).json({ error: 'Failed to update knowledge' });
  }
});

// ── Generate / return knobits for a node ─────────────────────────────────────
router.post('/nodes/:id/learn', async (req, res) => {
  const { id }      = req.params;
  const locale      = await getUserLocale(req.user?.id);
  const passportId  = req.user?.passport_id;

  try {
    const [nodes] = await db.execute(
      `SELECT n.id AS db_id, n.label, n.level, COALESCE(tr.label, n.label) AS display_label
       FROM nodes n
       LEFT JOIN node_translations tr ON tr.node_external_id = n.external_id AND tr.locale = ?
       WHERE n.external_id = ?`, [locale, id]
    );
    if (!nodes.length) return res.status(404).json({ error: 'Node not found' });
    const node = nodes[0];

    if (node.level !== 5) {
      return res.status(400).json({ error: 'Learn mode is only available for L5 leaf concepts' });
    }

    // Knobits are always stored in English
    let [knobits] = await db.execute(
      `SELECT id, sequence, title, target_bytes FROM knobits WHERE node_id = ? ORDER BY sequence`,
      [node.db_id]
    );

    if (!knobits.length) {
      // Generate in English and persist
      const domain     = await getNodeDomain(node.db_id);
      const breadcrumb = await getNodeBreadcrumb(node.db_id);
      const generated  = await llm.generateKnobits(node.label, domain, breadcrumb);
      for (const k of generated) {
        await db.execute(
          'INSERT INTO knobits (node_id, sequence, locale, title, target_bytes) VALUES (?, ?, ?, ?, ?)',
          [node.db_id, k.sequence, 'en', k.title, k.byteCount]
        );
      }
      [knobits] = await db.execute(
        `SELECT id, sequence, title, target_bytes FROM knobits WHERE node_id = ? ORDER BY sequence`,
        [node.db_id]
      );

      if (passportId) {
        const eventTitle = locale === 'et' ? `Alustasin õppimist: ${node.display_label}` : `Started learning: ${node.display_label}`;
        await db.execute(
          `INSERT INTO passport_events
             (passport_id, event_date, title, institution, result, node_external_id, type, sort_order)
           VALUES (?, CURDATE(), ?, 'KnoBitz platvorm', NULL, ?, 'activity', 0)`,
          [passportId, eventTitle, id]
        ).catch(() => {});
      }
    }

    // Translate titles for non-English locales — cached in knobit_translations so the
    // wording stays stable across visits instead of being (non-deterministically)
    // re-translated by the LLM on every single request.
    if (locale !== 'en') {
      const ids = knobits.map(k => k.id);
      const [cachedRows] = await db.execute(
        `SELECT knobit_id, title FROM knobit_translations WHERE locale = ? AND knobit_id IN (${ids.map(() => '?').join(',')})`,
        [locale, ...ids]
      );
      const cache = new Map(cachedRows.map(r => [r.knobit_id, r.title]));
      const missing = knobits.filter(k => !cache.has(k.id));
      if (missing.length) {
        let translated = await llm.translateKnobitTitles(missing, locale);
        const { titles } = await llm.editTranslatedText(
          { titles: translated.map(k => k.title) }, locale, req.user?.id
        );
        translated = translated.map((k, i) => ({ ...k, title: titles[i] || k.title }));
        for (const k of translated) {
          await db.execute(
            `INSERT INTO knobit_translations (knobit_id, locale, title) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE title = VALUES(title)`,
            [k.id, locale, k.title]
          );
          cache.set(k.id, k.title);
        }
      }
      knobits = knobits.map(k => ({ ...k, title: cache.get(k.id) || k.title }));
    }

    // Attach progress: mark which knobits are already done
    if (passportId) {
      const [progressRows] = await db.execute(
        `SELECT knobit_id FROM knobit_progress WHERE passport_id = ? AND phase_reached = 'done'`,
        [passportId]
      );
      const doneSet = new Set(progressRows.map(r => r.knobit_id));
      knobits = knobits.map(k => ({ ...k, done: doneSet.has(k.id) }));
    }

    // Attach a resumable mid-lesson session for the current (first unfinished) knobit, if any
    let resumeSession = null;
    const currentKnobit = knobits.find(k => !k.done);
    if (passportId && currentKnobit) {
      const [interactionRows] = await db.execute(
        `SELECT phase, block_type, block_index, choice_made, answer_text, content
         FROM knobit_interactions WHERE passport_id = ? AND knobit_id = ? ORDER BY id`,
        [passportId, currentKnobit.id]
      );
      if (interactionRows.length) resumeSession = { knobitId: currentKnobit.id, blocks: interactionRows };
    }

    res.json({ knobits, resumeSession });
  } catch (err) {
    console.error('[api/nodes/learn]', err.message);
    res.status(500).json({ error: 'Failed to prepare learning session' });
  }
});

// ── SSE helper: set headers and run an llm streaming call ───────────────────
// streamFn receives (write, writeStatus). Real Anthropic-streaming closures only
// take one param (their onChunk callback) and silently ignore the extra arg.
// writeStatus sends an out-of-band status frame — it never touches `full`, so it
// can't pollute the accumulated text that onDone/_saveInteraction persist.
async function _runStream(streamFn, res, onDone) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  // Keepalive: Apache buffers SSE; send every 3s so it sees traffic before timing out.
  const keepalive = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 3000);
  let full = '';
  const write = (chunk) => { full += chunk; try { res.write('data: ' + JSON.stringify({ t: chunk }) + '\n\n'); } catch (_) {} };
  const writeStatus = (key) => { try { res.write('data: ' + JSON.stringify({ status: key }) + '\n\n'); } catch (_) {} };
  try {
    await streamFn(write, writeStatus);
    if (onDone) await onDone(full);
  } catch (err) {
    console.error('[stream]', err.message);
    try { res.write('data: ' + JSON.stringify({ error: true }) + '\n\n'); } catch (_) {}
  }
  clearInterval(keepalive);
  try { res.write('data: [DONE]\n\n'); res.end(); } catch (_) {}
}

// ── Fake-stream: paces an already-complete string through the SSE `write`
// callback in small word-chunks with a short delay, so the client's real-time
// chunk-rendering code (built for genuine token streaming) works unchanged for
// text that was actually generated in one shot (e.g. after a second-pass edit).
async function _fakeStreamText(text, write, res) {
  const words = text.split(/(\s+)/);
  let buf = '', count = 0;
  for (const w of words) {
    if (res.writableEnded || res.destroyed) return;
    buf += w;
    if (/\S/.test(w)) count++;
    if (count >= 3 || w === words[words.length - 1]) {
      write(buf); buf = ''; count = 0;
      await new Promise((r) => setTimeout(r, 25 + Math.random() * 20));
    }
  }
}

// ── Builds a streamFn for a non-English locale: generate (non-streaming) →
// second-pass edit → fake-stream the corrected text through the SSE pipe.
// generateFn is a zero-arg async function returning the raw generated text.
function _editedStreamFn(generateFn, locale, uid, res) {
  return async (write, writeStatus) => {
    writeStatus('generating_text');
    const raw = await generateFn();
    writeStatus('checking_language');
    const { text } = await llm.editTranslatedText({ text: raw }, locale, uid);
    await _fakeStreamText(text, write, res);
  };
}

// ── Persist a Q4 test-completion result (score, event log, notification, gamification) ──
async function _saveTestResult(passportId, userId, nodeId, label, displayLabel, locale, evaluation) {
  if (evaluation.finalScore === undefined) return;
  await db.execute(
    `INSERT INTO user_node_knowledge
       (passport_id, node_external_id, percentage, source, updated_at)
     VALUES (?, ?, ?, 'tested', NOW())
     ON DUPLICATE KEY UPDATE
       percentage = VALUES(percentage), source = 'tested', updated_at = NOW()`,
    [passportId, nodeId, evaluation.finalScore]
  );
  updateAncestorKnowledge(passportId, nodeId).catch(() => {});
  const eventTitle  = locale === 'et' ? `Teadmiste test: ${displayLabel}` : `Knowledge test: ${displayLabel}`;
  const eventResult = locale === 'et' ? `Tulemus: ${evaluation.finalScore}%` : `Score: ${evaluation.finalScore}%`;
  await db.execute(
    `INSERT INTO passport_events
       (passport_id, event_date, title, institution, result, node_external_id, type, sort_order)
     VALUES (?, CURDATE(), ?, 'KnoBitz platvorm', ?, ?, 'assessment', 0)`,
    [passportId, eventTitle, eventResult, nodeId]
  );
  notify(userId, 'test_result',
    locale === 'et' ? `Testi tulemus: ${displayLabel}` : `Test result: ${displayLabel}`,
    locale === 'et' ? `Sinu tulemus: ${evaluation.finalScore}% teadmiste diagnostikas.` : `You scored ${evaluation.finalScore}% on the knowledge diagnostic.`, nodeId);
  const score      = evaluation.finalScore;
  const lumensBase = score === 100 ? 100 : score >= 80 ? 50 : 20;
  const reason     = score === 100 ? 'test_perfect' : 'test_complete';
  game.awardLumens(passportId, userId, lumensBase, reason, nodeId).catch(() => {});
  game.checkAchievements(passportId, userId, 'test_complete', { score }).catch(() => {});
}

// The 'ask' request phase isn't itself a valid knobit_interactions.phase ENUM
// value — an ask-bar question is asked *during* one of the four real phases,
// so it's persisted under that phase instead. `action` carries which one.
const _KNOBIT_PHASES = ['explain', 'demonstrate', 'practice', 'meaning'];
function _askDbPhase(action) {
  return _KNOBIT_PHASES.includes(action) ? action : 'explain';
}

// ── Persist a knobit lesson block for mid-lesson resume ─────────────────────
async function _saveInteraction(passportId, knobitId, phase, blockType, blockIndex, choiceMade, answerText, content) {
  if (!passportId) return;
  await db.execute(
    `INSERT INTO knobit_interactions (passport_id, knobit_id, phase, block_type, block_index, choice_made, answer_text, content)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [passportId, knobitId, phase, blockType, blockIndex, choiceMade || null, answerText || null, content]
  ).catch((err) => console.error('[knobit_interactions]', err.message));
}

// Reconstructs what this learner has actually been taught so far in this knobit
// (explain bytes + demonstrate example bodies), so practice questions/grading can
// be grounded in the real lesson content instead of independently reinvented.
async function _getLearnedContent(passportId, knobitId) {
  if (!passportId) return '';
  const [rows] = await db.execute(
    `SELECT block_type, content FROM knobit_interactions
     WHERE passport_id = ? AND knobit_id = ? AND phase IN ('explain', 'demonstrate')
     ORDER BY id`,
    [passportId, knobitId]
  );
  const parts = [];
  for (const row of rows) {
    if (row.block_type === 'byte') {
      parts.push(row.content);
    } else if (row.block_type === 'example') {
      try {
        const ex = JSON.parse(row.content || '{}');
        if (ex.body) parts.push(ex.body);
      } catch { /* malformed example JSON — skip, not worth failing the request over */ }
    }
  }
  return parts.join('\n\n');
}

// Practice problems already asked in this knobit — generatePractice() has no
// other way to know it already asked something nearly identical for an
// earlier problemIndex (e.g. "straightforward" vs "moderate" difficulty on
// the same fact tends to produce near-duplicate questions otherwise).
async function _getPriorPracticeQuestions(passportId, knobitId) {
  if (!passportId) return [];
  const [rows] = await db.execute(
    `SELECT content FROM knobit_interactions
     WHERE passport_id = ? AND knobit_id = ? AND phase = 'practice' AND block_type = 'practice'
     ORDER BY id`,
    [passportId, knobitId]
  );
  const questions = [];
  for (const row of rows) {
    try {
      const p = JSON.parse(row.content || '{}');
      if (p.question) questions.push(p.question);
    } catch { /* malformed practice JSON — skip */ }
  }
  return questions;
}

// ── LLM learning interactions ────────────────────────────────────────────────
router.post('/learn/interact', async (req, res) => {
  const {
    knobitId, phase, action,
    byteIndex = 0, answer, priorChoices = [],
    original = '', question = '', expected = '', userAnswer = '',
    context = '', seenUrls = [], previousExample = '',
    stream: wantStream = false,
  } = req.body;

  try {
    const [rows] = await db.execute(
      `SELECT k.title, n.label AS nodeLabel
       FROM knobits k JOIN nodes n ON k.node_id = n.id
       WHERE k.id = ?`,
      [knobitId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Knobit not found' });
    const { title, nodeLabel } = rows[0];
    const [locale, profile] = await Promise.all([
      getUserLocale(req.user?.id),
      getUserProfile(req.user?.id),
    ]);

    const uid = req.user?.id;
    const passportId = req.user?.passport_id;

    // ── Streaming branch: text-only phases ──────────────────────────────────
    if (wantStream) {
      let streamFn, onDone;
      if (phase === 'explain' && action !== 'visual') {
        const isRephrase = action === 'rephrase' || action === 'simpler' || action === 'complex';
        const generateFn = isRephrase
          ? () => llm.generateRephrase(nodeLabel, title, original, action, locale, profile, uid)
          : () => llm.generateExplainByteText(nodeLabel, title, byteIndex, original, locale, profile, uid);
        if (locale !== 'en') {
          streamFn = _editedStreamFn(generateFn, locale, uid, res);
        } else if (isRephrase) {
          streamFn = (cb) => llm.streamRephrase(nodeLabel, title, original, action, locale, profile, uid, cb);
        } else {
          streamFn = (cb) => llm.streamExplainByteText(nodeLabel, title, byteIndex, original, locale, profile, uid, cb);
        }
        onDone = (full) => _saveInteraction(passportId, knobitId, 'explain', 'byte', byteIndex, action || 'ok', null, full);
      } else if (phase === 'meaning') {
        const isRephrase = action === 'rephrase' || action === 'simpler' || action === 'complex';
        const generateFn = isRephrase
          ? () => llm.generateRephrase(nodeLabel, title, original, action, locale, profile, uid)
          : () => llm.generateMeaning(nodeLabel, title, locale, uid);
        if (locale !== 'en') {
          streamFn = _editedStreamFn(generateFn, locale, uid, res);
        } else if (isRephrase) {
          streamFn = (cb) => llm.streamRephrase(nodeLabel, title, original, action, locale, profile, uid, cb);
        } else {
          streamFn = (cb) => llm.streamMeaning(nodeLabel, title, locale, uid, cb);
        }
        onDone = (full) => _saveInteraction(passportId, knobitId, 'meaning', 'meaning', 0, action || 'ok', null, full);
      } else if (phase === 'ask') {
        const generateFn = () => llm.answerQuestion(nodeLabel, title, action || 'general', question, context, locale, profile, uid);
        if (locale !== 'en') {
          streamFn = _editedStreamFn(generateFn, locale, uid, res);
        } else {
          streamFn = (cb) => llm.streamAnswerQuestion(nodeLabel, title, action || 'general', question, context, locale, profile, uid, cb);
        }
        onDone = async (full) => {
          const dbPhase = _askDbPhase(action);
          await _saveInteraction(passportId, knobitId, dbPhase, 'user', 0, null, null, question);
          await _saveInteraction(passportId, knobitId, dbPhase, 'note', 0, null, null, full);
        };
      }
      if (streamFn) return _runStream(streamFn, res, onDone);
    }

    let result;

    if (phase === 'explain') {
      if (action === 'rephrase' || action === 'simpler' || action === 'complex') {
        let text = await llm.generateRephrase(nodeLabel, title, original, action, locale, profile, uid);
        if (locale !== 'en') ({ text } = await llm.editTranslatedText({ text }, locale, uid));
        result = { text };
        await _saveInteraction(passportId, knobitId, 'explain', 'byte', byteIndex, action, null, result.text);
      } else if (action === 'visual') {
        const validUrls = Array.isArray(seenUrls) ? seenUrls.filter(u => typeof u === 'string').slice(0, 20) : [];
        result = await llm.generateExplainByteVisual(nodeLabel, title, original, locale, uid, validUrls);
        if (result.visual) {
          if (locale !== 'en' && result.visual.caption) {
            const edited = await llm.editTranslatedText({ caption: result.visual.caption }, locale, uid);
            result.visual = { ...result.visual, caption: edited.caption };
          }
          await _saveInteraction(passportId, knobitId, 'explain', 'visual', byteIndex, null, null, JSON.stringify(result.visual));
        }
      } else {
        let text = await llm.generateExplainByteText(nodeLabel, title, byteIndex, original, locale, profile, uid);
        if (locale !== 'en') ({ text } = await llm.editTranslatedText({ text }, locale, uid));
        result = { text };
        await _saveInteraction(passportId, knobitId, 'explain', 'byte', byteIndex, 'ok', null, result.text);
      }
    } else if (phase === 'demonstrate') {
      let demonstrate = await llm.generateDemonstrate(nodeLabel, title, byteIndex, locale, profile, uid, previousExample);
      if (locale !== 'en') {
        const edited = await llm.editTranslatedText({ body: demonstrate.body, whatIDid: demonstrate.whatIDid }, locale, uid);
        demonstrate = { ...demonstrate, ...edited };
      }
      result = { demonstrate };
      await _saveInteraction(passportId, knobitId, 'demonstrate', 'example', byteIndex, null, null, JSON.stringify(result.demonstrate));
    } else if (phase === 'practice') {
      const learnedContent = await _getLearnedContent(passportId, knobitId);
      if (action === 'grade') {
        let grade = await llm.gradePractice(nodeLabel, title, question, expected, userAnswer, locale, uid, learnedContent);
        if (locale !== 'en') {
          const edited = await llm.editTranslatedText({ feedback: grade.feedback }, locale, uid);
          grade = { ...grade, ...edited };
        }
        result = { grade };
        await _saveInteraction(passportId, knobitId, 'practice', 'feedback', byteIndex, result.grade.correct ? 'correct' : 'incorrect', userAnswer, JSON.stringify(result.grade));
      } else {
        const priorQuestions = await _getPriorPracticeQuestions(passportId, knobitId);
        let practice = await llm.generatePractice(nodeLabel, title, byteIndex, locale, profile, uid, learnedContent, priorQuestions);
        if (locale !== 'en') {
          const edited = await llm.editTranslatedText({ question: practice.question }, locale, uid);
          practice = { ...practice, ...edited };
        }
        result = { practice };
        await _saveInteraction(passportId, knobitId, 'practice', 'practice', byteIndex, null, null, JSON.stringify(result.practice));
      }
    } else if (phase === 'meaning') {
      if (action === 'rephrase' || action === 'simpler' || action === 'complex') {
        let text = await llm.generateRephrase(nodeLabel, title, original, action, locale, profile, uid);
        if (locale !== 'en') ({ text } = await llm.editTranslatedText({ text }, locale, uid));
        result = { text };
        await _saveInteraction(passportId, knobitId, 'meaning', 'meaning', 0, action, null, result.text);
      } else {
        let text = await llm.generateMeaning(nodeLabel, title, locale, uid);
        if (locale !== 'en') ({ text } = await llm.editTranslatedText({ text }, locale, uid));
        result = { text };
        await _saveInteraction(passportId, knobitId, 'meaning', 'meaning', 0, 'ok', null, result.text);
      }
    } else if (phase === 'ask') {
      let text = await llm.answerQuestion(nodeLabel, title, action || 'general', question, context, locale, profile, uid);
      if (locale !== 'en') ({ text } = await llm.editTranslatedText({ text }, locale, uid));
      result = { text };
      const dbPhase = _askDbPhase(action);
      await _saveInteraction(passportId, knobitId, dbPhase, 'user', 0, null, null, question);
      await _saveInteraction(passportId, knobitId, dbPhase, 'note', 0, null, null, result.text);
    } else {
      return res.status(400).json({ error: `Unknown phase: ${phase}` });
    }

    res.json(result);
  } catch (err) {
    console.error('[api/learn/interact]', err.message);
    res.status(500).json({ error: 'LLM interaction failed: ' + err.message });
  }
});

// ── Download the in-progress knobit as a .docx (must be called before /complete,
//    which deletes the knobit_interactions rows this reads) ──────────────────
router.get('/learn/knobit/:id/download', async (req, res) => {
  const knobitId   = req.params.id;
  const passportId = req.user?.passport_id;
  if (!passportId) return res.status(400).json({ error: 'No passport' });

  try {
    const locale = await getUserLocale(req.user?.id);

    const [krows] = await db.execute(
      `SELECT COALESCE(trk.title, k.title) AS knobitTitle,
              COALESCE(trn.label, n.label) AS nodeLabel
       FROM knobits k
       JOIN nodes n ON k.node_id = n.id
       LEFT JOIN knobit_translations trk ON trk.knobit_id = k.id AND trk.locale = ?
       LEFT JOIN node_translations trn ON trn.node_external_id = n.external_id AND trn.locale = ?
       WHERE k.id = ?`,
      [locale, locale, knobitId]
    );
    if (!krows.length) return res.status(404).json({ error: 'Knobit not found' });
    const { knobitTitle, nodeLabel } = krows[0];

    const [rows] = await db.execute(
      `SELECT phase, block_type, block_index, choice_made, answer_text, content
       FROM knobit_interactions WHERE passport_id = ? AND knobit_id = ? ORDER BY id`,
      [passportId, knobitId]
    );

    const buffer = await buildKnobitDocx(rows, nodeLabel, knobitTitle, locale);
    const safeName = (knobitTitle || 'knobit').replace(/[<>:"/\\|?*\x00-\x1F]/g, '').trim().replace(/\s+/g, '_') || 'knobit';

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="knobit.docx"; filename*=UTF-8''${encodeURIComponent(safeName)}.docx`);
    res.send(buffer);
  } catch (err) {
    console.error('[api/learn/knobit/download]', err.message);
    res.status(500).json({ error: 'Failed to build download' });
  }
});

// ── Mark knobit complete ─────────────────────────────────────────────────────
router.post('/learn/knobit/:id/complete', async (req, res) => {
  const knobitId   = req.params.id;
  const passportId = req.user?.passport_id;
  if (!passportId) return res.status(400).json({ error: 'No passport' });

  try {
    const locale = await getUserLocale(req.user?.id);
    await db.execute(
      `INSERT INTO knobit_progress (passport_id, knobit_id, phase_reached, completed_at)
       VALUES (?, ?, 'done', NOW())
       ON DUPLICATE KEY UPDATE phase_reached = 'done', completed_at = NOW()`,
      [passportId, knobitId]
    );
    await db.execute(
      'DELETE FROM knobit_interactions WHERE passport_id = ? AND knobit_id = ?',
      [passportId, knobitId]
    ).catch(() => {});

    // Recompute node knowledge %
    const [krow] = await db.execute(
      `SELECT k.node_id, n.external_id AS nodeExtId,
              COALESCE(trn.label, n.label) AS nodeLabel, k.locale,
              COALESCE(trk.title, k.title) AS knobitTitle
       FROM knobits k
       JOIN nodes n ON k.node_id = n.id
       LEFT JOIN node_translations trn ON trn.node_external_id = n.external_id AND trn.locale = ?
       LEFT JOIN knobit_translations trk ON trk.knobit_id = k.id AND trk.locale = ?
       WHERE k.id = ?`,
      [locale, locale, knobitId]
    );
    if (krow.length) {
      const { node_id, nodeExtId, nodeLabel, knobitTitle } = krow[0];
      const [[{ total }]] = await db.execute(
        'SELECT COUNT(*) AS total FROM knobits WHERE node_id = ?',
        [node_id]
      );
      const [[{ done }]] = await db.execute(
        `SELECT COUNT(*) AS done
         FROM knobit_progress kp JOIN knobits k ON kp.knobit_id = k.id
         WHERE kp.passport_id = ? AND k.node_id = ? AND kp.phase_reached = 'done'`,
        [passportId, node_id]
      );
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;

      // Log every knobit completion as a learning event
      db.execute(
        `INSERT INTO passport_events (passport_id, event_date, title, institution, node_external_id, type, sort_order)
         VALUES (?, CURDATE(), ?, 'KnoBitz platvorm', ?, 'activity', 0)`,
        [passportId, locale === 'et' ? `Knobit läbitud: ${knobitTitle}` : `Knobit complete: ${knobitTitle}`, nodeExtId]
      ).catch(() => {});

      const userId = req.user?.id;
      const [[{ totalEver }]] = await db.execute(
        `SELECT COUNT(*) AS totalEver FROM knobit_progress
         WHERE passport_id = ? AND phase_reached = 'done'`,
        [passportId]
      );

      // Per-knobit notification
      if (totalEver === 1) {
        notify(userId, 'knobit_complete',
          locale === 'et' ? 'Esimene knobit läbitud!' : 'First knobit mastered!',
          locale === 'et'
            ? `Läbisid oma esimese õppesammu: "${knobitTitle}". Põnev teekond algab!`
            : `You completed your very first learning step: "${knobitTitle}". An exciting journey begins!`, nodeExtId);
      } else {
        notify(userId, 'knobit_complete',
          locale === 'et' ? `Knobit läbitud: ${knobitTitle}` : `Knobit complete: ${knobitTitle}`,
          locale === 'et' ? `Teema: ${nodeLabel}` : `Topic: ${nodeLabel}`, nodeExtId);
      }

      await db.execute(
        `INSERT INTO user_node_knowledge
           (passport_id, node_external_id, percentage, source, updated_at)
         VALUES (?, ?, ?, 'tested', NOW())
         ON DUPLICATE KEY UPDATE
           percentage = VALUES(percentage), source = 'tested', updated_at = NOW()`,
        [passportId, nodeExtId, pct]
      );
      updateAncestorKnowledge(passportId, nodeExtId).catch(() => {});

      if (pct === 100) {
        const credTitle = locale === 'et' ? `${nodeLabel} — Lõpetatud` : `${nodeLabel} — Completed`;
        const [[existing]] = await db.execute(
          `SELECT id FROM passport_credentials
           WHERE passport_id = ? AND type = 'platform' AND title = ?`,
          [passportId, credTitle]
        );
        if (!existing) {
          await db.execute(
            `INSERT INTO passport_credentials
               (passport_id, type, title, issuer, awarded_date, sort_order)
             VALUES (?, 'platform', ?, 'KnoBitz platvorm', CURDATE(), 0)`,
            [passportId, credTitle]
          );
          await db.execute(
            `INSERT INTO passport_events
               (passport_id, event_date, title, institution, node_external_id, type, sort_order)
             VALUES (?, CURDATE(), ?, 'KnoBitz platvorm', ?, 'evidence', 0)`,
            [passportId, locale === 'et' ? `Lõpetatud: ${nodeLabel}` : `Completed: ${nodeLabel}`, nodeExtId]
          );
          notify(userId, 'unit_complete',
            locale === 'et' ? `${nodeLabel} — täielikult omandatud!` : `${nodeLabel} — fully mastered!`,
            locale === 'et' ? 'Läbisid selle teema kõik õppesammud.' : "You've completed every learning step for this topic.", nodeExtId);
          notify(userId, 'credential',
            locale === 'et' ? `Uus tunnistus: ${credTitle}` : `New credential: ${credTitle}`,
            locale === 'et' ? 'Sinu õppija passi lisati platvormi tunnistus.' : 'A platform credential has been added to your Learner Passport.', nodeExtId);
        }
      }

      // ── Gamification ───────────────────────────────────────────────────────
      game.awardLumens(passportId, userId, 10, 'knobit_complete', knobitId).catch(() => {});
      if (done >= total && total > 0) {
        game.awardLumens(passportId, userId, 25, 'node_all_knobits', nodeExtId).catch(() => {});
      }
      game.checkAchievements(passportId, userId, 'knobit_complete', { totalEver }).catch(() => {});

      // ── Goal completion ────────────────────────────────────────────────────
      if (pct === 100) {
        const [goalHit] = await db.execute(
          `SELECT id FROM passport_goals
           WHERE passport_id = ? AND node_external_id = ? AND status = 'in_progress'`,
          [passportId, nodeExtId]
        );
        if (goalHit.length) {
          await db.execute(
            `UPDATE passport_goals SET status='completed', completed_at=NOW() WHERE id=?`,
            [goalHit[0].id]
          );
          notify(userId, 'goal_complete',
            locale === 'et' ? 'Eesmärk täidetud! 🎉' : 'Goal completed! 🎉',
            locale === 'et' ? `Läbisid: "${nodeLabel}"` : `You finished: "${nodeLabel}"`, nodeExtId);
          return res.json({ ok: true, goalCompleted: { nodeLabel, nodeExtId } });
        }
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[api/learn/knobit/complete]', err.message);
    res.status(500).json({ error: 'Failed to save knobit completion' });
  }
});

// ── Map progress for current user ────────────────────────────────────────────
router.get('/map/progress', async (req, res) => {
  const passportId = req.user?.passport_id;
  if (!passportId) return res.json({});
  try {
    const [rows] = await db.execute(
      `SELECT node_external_id AS id, percentage
       FROM user_node_knowledge WHERE passport_id = ? AND percentage > 0`,
      [passportId]
    );
    const map = {};
    rows.forEach(r => { map[r.id] = r.percentage; });
    res.json(map);
  } catch (err) {
    res.status(500).json({});
  }
});

// ── Full profile data for current user ───────────────────────────────────────
router.get('/profile', async (req, res) => {
  const passportId = req.user?.passport_id;
  if (!passportId) return res.status(400).json({ error: 'No passport' });

  try {
    const locale = await getUserLocale(req.user?.id);
    const data = await _fetchFullPassport(passportId, locale);
    res.json({ ...data, role: req.user.role });
  } catch (err) {
    console.error('[api/profile]', err.message);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

// ── Anne — mentor chat widget ────────────────────────────────────────────────
router.get('/anne/messages', async (req, res) => {
  const passportId = req.user?.passport_id;
  if (!passportId) return res.status(400).json({ error: 'No passport' });
  try {
    const [rows] = await db.execute(
      `SELECT id, role, content, created_at FROM anne_messages
       WHERE passport_id = ? ORDER BY id DESC LIMIT 50`,
      [passportId]
    );
    res.json(rows.reverse());
  } catch (err) {
    console.error('[api/anne/messages]', err.message);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

router.post('/anne/message', async (req, res) => {
  const passportId = req.user?.passport_id;
  const uid = req.user?.id;
  if (!passportId) return res.status(400).json({ error: 'No passport' });
  const { message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'message required' });

  try {
    const locale = await getUserLocale(uid);

    const [historyRows] = await db.execute(
      `SELECT role, content FROM anne_messages WHERE passport_id = ? ORDER BY id DESC LIMIT 20`,
      [passportId]
    );
    const history = historyRows.reverse();

    await db.execute(
      'INSERT INTO anne_messages (passport_id, role, content, locale) VALUES (?, "user", ?, ?)',
      [passportId, message, locale]
    );

    const passportData = await _fetchFullPassport(passportId, locale);
    const passportText = renderPassportText(passportData);

    let streamFn;
    if (locale !== 'en') {
      streamFn = _editedStreamFn(() => llm.generateAnneReply(passportText, history, message, locale, uid), locale, uid, res);
    } else {
      streamFn = (write) => llm.streamAnneReply(passportText, history, message, locale, uid, write);
    }
    const onDone = (full) => db.execute(
      'INSERT INTO anne_messages (passport_id, role, content, locale) VALUES (?, "assistant", ?, ?)',
      [passportId, full, locale]
    );
    return _runStream(streamFn, res, onDone);
  } catch (err) {
    console.error('[api/anne/message]', err.message);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ── Manual learning events ───────────────────────────────────────────────────
router.post('/profile/events', async (req, res) => {
  const passportId = req.user?.passport_id;
  if (!passportId) return res.status(400).json({ error: 'No passport' });
  const { title, institution, result, event_date, reflection } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'title required' });
  try {
    const [evResult] = await db.execute(
      `INSERT INTO passport_events (passport_id, event_date, title, institution, result, type, user_created, sort_order)
       VALUES (?, ?, ?, ?, ?, 'activity', 1, 0)`,
      [passportId, event_date || new Date().toISOString().split('T')[0], title.trim(), institution || null, result || null]
    );
    if (reflection?.trim()) {
      await db.execute(
        `INSERT INTO passport_reflections (passport_id, event_id, text, created_at)
         VALUES (?, ?, ?, NOW())`,
        [passportId, evResult.insertId, reflection.trim()]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add event' });
  }
});

// ── Reflections ───────────────────────────────────────────────────────────────
router.post('/profile/reflections', async (req, res) => {
  const passportId = req.user?.passport_id;
  if (!passportId) return res.status(400).json({ error: 'No passport' });
  const { text, event_id } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'text required' });
  try {
    const [result] = await db.execute(
      `INSERT INTO passport_reflections (passport_id, event_id, text, created_at)
       VALUES (?, ?, ?, NOW())`,
      [passportId, event_id || null, text.trim()]
    );
    res.json({ id: result.insertId, ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save reflection' });
  }
});

router.delete('/profile/events/:id', async (req, res) => {
  const passportId = req.user?.passport_id;
  if (!passportId) return res.status(400).json({ error: 'No passport' });
  try {
    await db.execute(
      `DELETE FROM passport_events WHERE id = ? AND passport_id = ? AND user_created = 1`,
      [req.params.id, passportId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete event' });
  }
});

// ── Goals ────────────────────────────────────────────────────────────────────
router.post('/profile/goals', async (req, res) => {
  const passportId = req.user?.passport_id;
  if (!passportId) return res.status(400).json({ error: 'No passport' });
  const { text, node_external_id, node_breadcrumb, target_date } = req.body;
  const goalText = node_external_id ? (node_breadcrumb || node_external_id) : text?.trim();
  if (!goalText) return res.status(400).json({ error: 'text or node_external_id required' });
  try {
    // Prevent duplicate active node goals for the same node
    if (node_external_id) {
      const [existing] = await db.execute(
        `SELECT id FROM passport_goals WHERE passport_id = ? AND node_external_id = ? AND status = 'in_progress'`,
        [passportId, node_external_id]
      );
      if (existing.length) return res.json({ id: existing[0].id, ok: true, duplicate: true });
    }
    const [result] = await db.execute(
      `INSERT INTO passport_goals (passport_id, text, node_external_id, node_breadcrumb, target_date, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'in_progress', NOW())`,
      [passportId, goalText, node_external_id || null, node_breadcrumb || null, target_date || null]
    );
    res.json({ id: result.insertId, ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add goal' });
  }
});

router.post('/profile/goals/:id/complete', async (req, res) => {
  const passportId = req.user?.passport_id;
  if (!passportId) return res.status(400).json({ error: 'No passport' });
  try {
    const locale = await getUserLocale(req.user?.id);
    const [goals] = await db.execute(
      'SELECT text, node_external_id, node_breadcrumb FROM passport_goals WHERE id = ? AND passport_id = ?',
      [req.params.id, passportId]
    );
    await db.execute(
      `UPDATE passport_goals SET status='completed', completed_at=NOW() WHERE id=? AND passport_id=?`,
      [req.params.id, passportId]
    );
    if (goals.length) {
      const g = goals[0];
      const label = g.node_breadcrumb || g.text;
      notify(req.user?.id, 'goal_complete',
        locale === 'et' ? 'Eesmärk täidetud! 🎉' : 'Goal completed! 🎉',
        locale === 'et' ? `Läbisid: "${label}"` : `You finished: "${label}"`, g.node_external_id);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to complete goal' });
  }
});

router.delete('/profile/goals/:id', async (req, res) => {
  const passportId = req.user?.passport_id;
  if (!passportId) return res.status(400).json({ error: 'No passport' });
  try {
    await db.execute(
      'DELETE FROM passport_goals WHERE id=? AND passport_id=?',
      [req.params.id, passportId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete goal' });
  }
});

// ── Credentials (manual entry) ───────────────────────────────────────────────
router.post('/profile/credentials', async (req, res) => {
  const passportId = req.user?.passport_id;
  if (!passportId) return res.status(400).json({ error: 'No passport' });
  const { type, title, issuer, awarded_date, grade } = req.body;
  if (!['qualification','certification','award'].includes(type) || !title?.trim()) {
    return res.status(400).json({ error: 'type and title required' });
  }
  try {
    const [result] = await db.execute(
      `INSERT INTO passport_credentials (passport_id, type, title, issuer, awarded_date, grade, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [passportId, type, title.trim(), issuer || null,
       awarded_date ? awarded_date + '-01' : null, grade || null]
    );
    res.json({ id: result.insertId, ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add credential' });
  }
});

router.delete('/profile/credentials/:id', async (req, res) => {
  const passportId = req.user?.passport_id;
  if (!passportId) return res.status(400).json({ error: 'No passport' });
  try {
    await db.execute(
      `DELETE FROM passport_credentials WHERE id = ? AND passport_id = ? AND type != 'platform'`,
      [req.params.id, passportId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete credential' });
  }
});

// ── Relationships (individuals, groups, providers) ───────────────────────────
router.post('/profile/relationships', async (req, res) => {
  const passportId = req.user?.passport_id;
  if (!passportId) return res.status(400).json({ error: 'No passport' });
  const { type, name, role_description, status } = req.body;
  if (!['individual','group','institution','tool'].includes(type) || !name?.trim()) {
    return res.status(400).json({ error: 'type and name required' });
  }
  try {
    const [result] = await db.execute(
      `INSERT INTO passport_relationships (passport_id, type, name, role_description, status, sort_order)
       VALUES (?, ?, ?, ?, ?, 0)`,
      [passportId, type, name.trim(), role_description || null, status || null]
    );
    res.json({ id: result.insertId, ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add relationship' });
  }
});

router.delete('/profile/relationships/:id', async (req, res) => {
  const passportId = req.user?.passport_id;
  if (!passportId) return res.status(400).json({ error: 'No passport' });
  try {
    await db.execute(
      'DELETE FROM passport_relationships WHERE id = ? AND passport_id = ?',
      [req.params.id, passportId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete relationship' });
  }
});

// ── Interests & Values (passport_tags) ───────────────────────────────────────
router.post('/profile/tags', async (req, res) => {
  const passportId = req.user?.passport_id;
  if (!passportId) return res.status(400).json({ error: 'No passport' });
  const { type, text } = req.body;
  if (!['interest', 'value'].includes(type) || !text?.trim()) {
    return res.status(400).json({ error: 'type and text required' });
  }
  try {
    const [result] = await db.execute(
      'INSERT INTO passport_tags (passport_id, type, text, sort_order) VALUES (?, ?, ?, 0)',
      [passportId, type, text.trim()]
    );
    res.json({ id: result.insertId, type, text: text.trim() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add tag' });
  }
});

router.delete('/profile/tags/:id', async (req, res) => {
  const passportId = req.user?.passport_id;
  if (!passportId) return res.status(400).json({ error: 'No passport' });
  try {
    await db.execute(
      'DELETE FROM passport_tags WHERE id = ? AND passport_id = ?',
      [req.params.id, passportId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete tag' });
  }
});

// ── Update basic passport identity ───────────────────────────────────────────
router.post('/profile/identity', async (req, res) => {
  const passportId = req.user?.passport_id;
  if (!passportId) return res.status(400).json({ error: 'No passport' });
  // Only update fields that were actually sent — prevents wiping unrelated fields
  const ALLOWED = ['display_name', 'birth_year', 'location', 'cultural_background', 'id_number', 'about'];
  const updates = {};
  ALLOWED.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f] || null; });
  if (!Object.keys(updates).length) return res.json({ ok: true });
  try {
    const sets = Object.keys(updates).map(f => `${f} = ?`).join(', ');
    await db.execute(
      `UPDATE learner_passports SET ${sets}, updated_at = NOW() WHERE id = ?`,
      [...Object.values(updates), passportId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update identity' });
  }
});

// ── Notifications ────────────────────────────────────────────────────────────
router.get('/notifications/unread-count', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.json({ count: 0 });
  try {
    const [[{ count }]] = await db.execute(
      'SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0',
      [userId]
    );
    res.json({ count });
  } catch (err) {
    res.json({ count: 0 });
  }
});

router.get('/notifications', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const [rows] = await db.execute(
      `SELECT id, type, title, body, icon_color, is_read, created_at, node_external_id
       FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
      [userId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[api/notifications]', err.message);
    res.status(500).json({ error: 'Failed to load notifications' });
  }
});

router.post('/notifications/read-all', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    await db.execute(
      'UPDATE notifications SET is_read = 1 WHERE user_id = ?', [userId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark all read' });
  }
});

router.post('/notifications/:id/read', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    await db.execute(
      'UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?',
      [req.params.id, userId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark read' });
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

// Recompute and store estimated knowledge % for all ancestors of a node.
// Called fire-and-forget after any knowledge write. Never overwrites
// explicit self_reported or tested entries.
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

async function getNodeDomain(nodeDbId) {
  // Walk up to level-1 ancestor via recursive CTE
  const [rows] = await db.execute(
    `WITH RECURSIVE anc AS (
       SELECT id, label, level, parent_id FROM nodes WHERE id = ?
       UNION ALL
       SELECT n.id, n.label, n.level, n.parent_id
       FROM nodes n JOIN anc a ON n.id = a.parent_id
     )
     SELECT label FROM anc WHERE level = 1 LIMIT 1`,
    [nodeDbId]
  );
  return rows.length ? rows[0].label : 'Unknown';
}

async function getNodeBreadcrumb(nodeDbId) {
  const [rows] = await db.execute(
    `WITH RECURSIVE anc AS (
       SELECT id, label, level, parent_id FROM nodes WHERE id = ?
       UNION ALL
       SELECT n.id, n.label, n.level, n.parent_id
       FROM nodes n JOIN anc a ON n.id = a.parent_id
     )
     SELECT label, level FROM anc ORDER BY level ASC`,
    [nodeDbId]
  );
  return rows.map(r => r.label).join(' › ');
}

// ── 4-tier diagnostic: generate question ─────────────────────────────────────
router.post('/test/question', async (req, res) => {
  const { nodeId, questionNum, history = [], stream: wantStream = false } = req.body;
  try {
    const [nodes] = await db.execute(
      'SELECT id AS db_id, label, level FROM nodes WHERE external_id = ?', [nodeId]
    );
    if (!nodes.length) return res.status(404).json({ error: 'Node not found' });
    const { db_id, label, level } = nodes[0];
    if (level < 4) return res.status(400).json({ error: 'Test only available for L4 and L5 nodes' });
    const breadcrumb = await getNodeBreadcrumb(db_id);
    const locale = await getUserLocale(req.user?.id);
    // Age-based wording simplification — opt-in only. Unknown age or 18+
    // leaves the prompt completely unchanged (age stays null/undefined).
    const profile = await getUserProfile(req.user?.id);
    const age = profile?.birth_year ? new Date().getFullYear() - profile.birth_year : null;
    if (wantStream) {
      return _runStream((cb) => llm.streamTestQuestion(label, breadcrumb, questionNum, history, locale, req.user?.id, cb, age), res);
    }
    let result = await llm.generateTestQuestion(label, breadcrumb, questionNum, history, locale, req.user?.id, age);
    if (locale !== 'en') {
      const editFields = { question: result.question };
      if (result.type === 'mcq' && Array.isArray(result.options)) editFields.options = result.options;
      const edited = await llm.editTranslatedText(editFields, locale, req.user?.id);
      result = { ...result, ...edited };
    }
    testlog('route_question_generated', { userId: req.user?.id, nodeId, nodeLabel: label, questionNum, history, result }); // TESTLOG
    res.json(result);
  } catch (err) {
    console.error('[api/test/question]', err.message);
    res.status(500).json({ error: 'Failed to generate question' });
  }
});

// TESTLOG — client-side event logger (Q1-Q3 MCQ local evaluation). Remove with other TESTLOG markers.
router.post('/test/log', (req, res) => {
  testlog('client_mcq_local', { userId: req.user?.id, ...req.body });
  res.json({ ok: true });
});

// ── 4-tier diagnostic: evaluate answer ───────────────────────────────────────
router.post('/test/evaluate', async (req, res) => {
  const { nodeId, questionNum, question, options, userAnswer, correctIndex, history = [], stream: wantStream = false } = req.body;
  const passportId = req.user?.passport_id;

  try {
    const locale = await getUserLocale(req.user?.id);
    const [nodes] = await db.execute(
      `SELECT n.id AS db_id, n.label, COALESCE(tr.label, n.label) AS display_label, n.level
       FROM nodes n
       LEFT JOIN node_translations tr ON tr.node_external_id = n.external_id AND tr.locale = ?
       WHERE n.external_id = ?`, [locale, nodeId]
    );
    if (!nodes.length) return res.status(404).json({ error: 'Node not found' });
    const { db_id, label, display_label } = nodes[0];
    const breadcrumb = await getNodeBreadcrumb(db_id);

    testlog('route_evaluate_input', { userId: req.user?.id, nodeId, nodeLabel: label, questionNum, question, options, correctIndex, userAnswer, history }); // TESTLOG

    if (wantStream) {
      let streamFn;
      if (locale !== 'en') {
        streamFn = async (write, writeStatus) => {
          writeStatus('generating_text');
          const evaluation = await llm.evaluateTestAnswer(
            label, breadcrumb, questionNum, question, options, userAnswer, correctIndex, history, locale, req.user?.id
          );
          writeStatus('checking_language');
          const editFields = { feedback: evaluation.feedback };
          if (questionNum === 4 && evaluation.scoreBreakdown) editFields.scoreBreakdown = evaluation.scoreBreakdown;
          const edited = await llm.editTranslatedText(editFields, locale, req.user?.id);
          await _fakeStreamText(JSON.stringify({ ...evaluation, ...edited }), write, res);
        };
      } else {
        streamFn = (write) => llm.streamTestEvaluate(
          label, breadcrumb, questionNum, question, options, userAnswer, correctIndex, history, locale, req.user?.id, write
        );
      }
      const onDone = async (fullText) => {
        testlog('route_evaluate_stream_response', { userId: req.user?.id, questionNum, raw: fullText }); // TESTLOG
        if (questionNum !== 4 || !passportId) return;
        try {
          const cleaned = fullText.trim()
            .replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
          const evaluation = JSON.parse(cleaned);
          await _saveTestResult(passportId, req.user?.id, nodeId, label, display_label, locale, evaluation);
        } catch (e) {
          console.error('[api/test/evaluate] Q4 post-stream error', e.message);
        }
      };
      return _runStream(streamFn, res, onDone);
    }

    let evaluation = await llm.evaluateTestAnswer(
      label, breadcrumb, questionNum, question, options, userAnswer, correctIndex, history, locale, req.user?.id
    );
    if (locale !== 'en') {
      const editFields = { feedback: evaluation.feedback };
      if (questionNum === 4 && evaluation.scoreBreakdown) editFields.scoreBreakdown = evaluation.scoreBreakdown;
      const edited = await llm.editTranslatedText(editFields, locale, req.user?.id);
      evaluation = { ...evaluation, ...edited };
    }

    if (questionNum === 4 && passportId) {
      await _saveTestResult(passportId, req.user?.id, nodeId, label, display_label, locale, evaluation);
    }

    res.json(evaluation);
  } catch (err) {
    console.error('[api/test/evaluate]', err.message);
    res.status(500).json({ error: 'Evaluation failed' });
  }
});

// ── Node suggestion (rephrase limit reached) ─────────────────────────────────
// direction=easier → find the nearest unlearned L5 sibling before this node
// direction=harder → find the nearest unlearned L5 sibling after this node
router.get('/nodes/:id/suggest', async (req, res) => {
  const { id }       = req.params;
  const { direction } = req.query;
  const passportId   = req.user?.passport_id;

  if (!['easier', 'harder'].includes(direction)) {
    return res.status(400).json({ error: 'direction must be easier or harder' });
  }

  try {
    const [rows] = await db.execute(
      'SELECT id AS db_id, parent_id FROM nodes WHERE external_id = ? AND is_active = 1', [id]
    );
    if (!rows.length) return res.json({ suggestion: null });
    const { db_id: currentDbId, parent_id: parentId } = rows[0];

    const idCompare = direction === 'easier' ? '<' : '>';
    const idOrder   = direction === 'easier' ? 'DESC' : 'ASC';

    let sql, params;
    if (passportId) {
      sql = `
        SELECT n.external_id AS id, n.label,
               p1.label AS p1, p2.label AS p2, p3.label AS p3
        FROM nodes n
        JOIN nodes p1 ON p1.id = n.parent_id
        LEFT JOIN nodes p2 ON p2.id = p1.parent_id
        LEFT JOIN nodes p3 ON p3.id = p2.parent_id
        WHERE n.parent_id = ?
          AND n.level = 5
          AND n.is_active = 1
          AND n.id ${idCompare} ?
          AND n.id NOT IN (
            SELECT DISTINCT k.node_id FROM knobit_progress kp
            JOIN knobits k ON kp.knobit_id = k.id
            WHERE kp.passport_id = ? AND kp.phase_reached = 'done'
          )
        ORDER BY n.id ${idOrder}
        LIMIT 1`;
      params = [parentId, currentDbId, passportId];
    } else {
      sql = `
        SELECT n.external_id AS id, n.label,
               p1.label AS p1, p2.label AS p2, p3.label AS p3
        FROM nodes n
        JOIN nodes p1 ON p1.id = n.parent_id
        LEFT JOIN nodes p2 ON p2.id = p1.parent_id
        LEFT JOIN nodes p3 ON p3.id = p2.parent_id
        WHERE n.parent_id = ?
          AND n.level = 5
          AND n.is_active = 1
          AND n.id ${idCompare} ?
        ORDER BY n.id ${idOrder}
        LIMIT 1`;
      params = [parentId, currentDbId];
    }

    const [suggestions] = await db.execute(sql, params);
    if (!suggestions.length) return res.json({ suggestion: null });

    const s = suggestions[0];
    res.json({
      suggestion: {
        id:         s.id,
        label:      s.label,
        breadcrumb: [s.p3, s.p2, s.p1].filter(Boolean).join(' › '),
      },
    });
  } catch (err) {
    console.error('[api/nodes/suggest]', err.message);
    res.json({ suggestion: null });
  }
});

// ── Admin: token usage per user ───────────────────────────────────────────────
router.get('/admin/token-usage', async (req, res) => {
  if (!req.user || !['admin', 'super_admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const [totals] = await db.execute(`
      SELECT u.id, u.email, u.role,
             SUM(t.input_tokens)  AS input_tokens,
             SUM(t.output_tokens) AS output_tokens,
             SUM(t.input_tokens + t.output_tokens) AS total_tokens,
             COUNT(*)             AS call_count,
             MAX(t.created_at)    AS last_call
      FROM token_usage t
      JOIN users u ON t.user_id = u.id
      GROUP BY u.id
      ORDER BY total_tokens DESC
    `);
    const [byType] = await db.execute(`
      SELECT u.email, t.call_type,
             SUM(t.input_tokens + t.output_tokens) AS tokens,
             COUNT(*) AS calls
      FROM token_usage t
      JOIN users u ON t.user_id = u.id
      GROUP BY u.id, t.call_type
      ORDER BY u.email, tokens DESC
    `);
    res.json({ totals, byType });
  } catch (err) {
    console.error('[api/admin/token-usage]', err.message);
    res.status(500).json({ error: 'Failed to fetch token usage' });
  }
});

// ── Game state ───────────────────────────────────────────────────────────────
router.get('/game/state', async (req, res) => {
  const passportId = req.user?.passport_id;
  if (!passportId) return res.json(null);
  const state = await game.getGameState(passportId);
  res.json(state);
});

// ── Game mode toggle ─────────────────────────────────────────────────────────
router.post('/game/settings', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const { enabled } = req.body;
  try {
    await db.execute(
      `INSERT INTO user_settings (user_id, key_name, value) VALUES (?, 'game_mode', ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value)`,
      [userId, enabled ? 'on' : 'off']
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save setting' });
  }
});

// ── Achievements list ────────────────────────────────────────────────────────
router.get('/game/achievements', async (req, res) => {
  const passportId = req.user?.passport_id;
  const all = game.getAllAchievements();
  if (!passportId) return res.json(all.map(a => ({ ...a, unlocked: false })));
  try {
    const [unlocked] = await db.execute(
      'SELECT achievement_key, unlocked_at FROM user_achievements WHERE passport_id = ?',
      [passportId]
    );
    const unlockedMap = Object.fromEntries(unlocked.map(r => [r.achievement_key, r.unlocked_at]));
    res.json(all.map(a => ({
      ...a,
      unlocked: !!unlockedMap[a.key],
      unlocked_at: unlockedMap[a.key] || null,
    })));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load achievements' });
  }
});

// ── Leaderboard ──────────────────────────────────────────────────────────────
router.get('/game/leaderboard', async (req, res) => {
  try {
    const [weekly] = await db.execute(
      `SELECT lp.display_name, SUM(lt.amount) AS lumens_this_week
       FROM lumen_transactions lt
       JOIN learner_passports lp ON lt.passport_id = lp.id
       WHERE lt.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
       GROUP BY lt.passport_id
       ORDER BY lumens_this_week DESC
       LIMIT 20`
    );
    const [territory] = await db.execute(
      `SELECT lp.display_name, lp.lumen_total
       FROM learner_passports lp
       WHERE lp.lumen_total > 0
       ORDER BY lp.lumen_total DESC
       LIMIT 20`
    );
    res.json({ weekly, territory });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load leaderboard' });
  }
});

// ── Learner links (parent / teacher) ─────────────────────────────────────────
router.get('/links', async (req, res) => {
  const userId = req.user?.id;
  const passportId = req.user?.passport_id;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const [asStudent] = await db.execute(
      `SELECT ll.*, lp.display_name AS linked_name
       FROM learner_links ll
       JOIN users u ON u.id = ll.linked_user_id
       LEFT JOIN learner_passports lp ON lp.id = u.passport_id
       WHERE ll.passport_id = ? AND ll.status != 'revoked'`,
      [passportId]
    );
    const [asLinked] = await db.execute(
      `SELECT ll.*, lp.display_name AS student_name, u.id AS student_user_id
       FROM learner_links ll
       LEFT JOIN learner_passports lp ON lp.id = ll.passport_id
       LEFT JOIN users u ON u.passport_id = lp.id
       WHERE ll.linked_user_id = ? AND ll.status != 'revoked'`,
      [userId]
    );
    res.json({ asStudent, asLinked });
  } catch (err) {
    console.error('GET /api/links failed:', err);
    res.status(500).json({ error: 'Failed to load links' });
  }
});

// A teacher/parent's own connection code — persistent and reusable by many
// students/children until explicitly regenerated (not single-use). Stored
// directly on their users row rather than on a learner_links pending row,
// since it isn't tied to any one student.
router.get('/links/my-code', async (req, res) => {
  const role = req.user?.role;
  if (!['teacher', 'parent', 'admin', 'super_admin'].includes(role)) {
    return res.status(403).json({ error: 'not_allowed' });
  }
  try {
    const [rows] = await db.execute(
      'SELECT link_code, link_code_role, link_code_generated_at FROM users WHERE id = ?',
      [req.user.id]
    );
    const row = rows[0] || {};
    res.json({
      code: row.link_code || null,
      role: row.link_code_role || null,
      generatedAt: row.link_code_generated_at || null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load code' });
  }
});

router.post('/links/my-code/generate', async (req, res) => {
  const userId  = req.user?.id;
  const account = req.user?.role;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  // A real teacher/parent account always generates in their own role — the
  // body is ignored. Only admin/super_admin (testing/support) must say which
  // kind of code they mean, since their account isn't inherently either.
  let asRole;
  if (account === 'teacher' || account === 'parent') {
    asRole = account;
  } else if (account === 'admin' || account === 'super_admin') {
    asRole = req.body?.asRole;
    if (!['teacher', 'parent'].includes(asRole)) {
      return res.status(400).json({ error: 'asRole must be teacher or parent' });
    }
  } else {
    return res.status(403).json({ error: 'not_allowed' });
  }

  try {
    const code = generateCode();
    await db.execute(
      'UPDATE users SET link_code = ?, link_code_role = ?, link_code_generated_at = NOW() WHERE id = ?',
      [code, asRole, userId]
    );
    res.json({ code, role: asRole, generatedAt: new Date() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate code' });
  }
});

// Learner redeems a teacher/parent's code. Eligibility (role=learner, age<=20)
// is enforced in the shared service — same rules as the signup-wizard path.
router.post('/links/redeem', async (req, res) => {
  const passportId = req.user?.passport_id;
  const userId     = req.user?.id;
  if (!userId || !passportId) return res.status(400).json({ error: 'no_passport' });

  const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';
  try {
    const [passportRows] = await db.execute('SELECT birth_year FROM learner_passports WHERE id = ?', [passportId]);
    const birthYear = passportRows[0]?.birth_year || null;

    const result = await redeemLinkCode({
      passportId,
      userId,
      userRole: req.user.role,
      birthYear,
      code: req.body?.code,
      bypassChecks: isAdmin,
    });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// Child-initiated: learner invites a parent by email (the reverse of the
// persistent-code flow — only children can start it this way).
router.post('/links/invite-parent', async (req, res) => {
  const passportId = req.user?.passport_id;
  if (!passportId) return res.status(400).json({ error: 'no_passport' });
  const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';
  try {
    const [passportRows] = await db.execute('SELECT birth_year FROM learner_passports WHERE id = ?', [passportId]);
    const birthYear = passportRows[0]?.birth_year || null;
    const result = await sendChildInvite({
      passportId,
      userRole: req.user.role,
      birthYear,
      email: req.body?.email,
      bypassChecks: isAdmin,
    });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    console.error('POST /api/links/invite-parent failed:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Parent redeems the one-time code from a child's invite email.
router.post('/links/redeem-child-invite', async (req, res) => {
  const parentUserId = req.user?.id;
  const parentPassportId = req.user?.passport_id;
  if (!parentUserId || !parentPassportId) return res.status(400).json({ error: 'no_passport' });
  const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';
  if (!isAdmin && req.user.role !== 'parent') return res.status(403).json({ error: 'role_not_allowed' });
  try {
    const result = await acceptChildInvite({
      parentUserId,
      parentPassportId,
      code: req.body?.code,
      bypassChecks: isAdmin,
    });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    console.error('POST /api/links/redeem-child-invite failed:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

router.delete('/links/:id', async (req, res) => {
  const userId = req.user?.id;
  const passportId = req.user?.passport_id;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const [rows] = await db.execute(
      `SELECT ll.*, lp.display_name AS student_name, lp.birth_year AS student_birth_year, lu_lp.display_name AS linked_name
       FROM learner_links ll
       LEFT JOIN learner_passports lp ON lp.id = ll.passport_id
       LEFT JOIN users lu ON lu.id = ll.linked_user_id
       LEFT JOIN learner_passports lu_lp ON lu_lp.id = lu.passport_id
       WHERE ll.id = ? AND (ll.passport_id = ? OR ll.linked_user_id = ?)`,
      [req.params.id, passportId, userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const link = rows[0];

    // Parent-child links: under-13 children can't disconnect themselves —
    // only the parent side can. Teacher-student links stay symmetric.
    const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';
    if (!isAdmin && link.role === 'parent' && link.student_birth_year) {
      const age = new Date().getFullYear() - link.student_birth_year;
      const isParentSide = userId === link.linked_user_id;
      if (age < 13 && !isParentSide) {
        return res.status(403).json({ error: 'too_young_to_disconnect' });
      }
    }

    await db.execute(`UPDATE learner_links SET status = 'revoked' WHERE id = ?`, [req.params.id]);

    // Notify whichever side didn't initiate the disconnect.
    if (userId === link.linked_user_id) {
      // Teacher/parent disconnected — notify the learner, if they can log in.
      const [learnerUsers] = await db.execute('SELECT id FROM users WHERE passport_id = ?', [link.passport_id]);
      if (learnerUsers.length) {
        const locale = await getUserLocale(learnerUsers[0].id);
        const name = link.linked_name || (locale === 'et' ? 'Kasutaja' : 'A user');
        notify(learnerUsers[0].id, 'link_removed',
          locale === 'et' ? 'Ühendus katkestatud' : 'Connection removed',
          locale === 'et' ? `${name} katkestas ühenduse.` : `${name} disconnected.`);
      }
    } else if (link.linked_user_id) {
      const locale = await getUserLocale(link.linked_user_id);
      const name = link.student_name || (locale === 'et' ? 'Õpilane' : 'A student');
      notify(link.linked_user_id, 'link_removed',
        locale === 'et' ? 'Ühendus katkestatud' : 'Connection removed',
        locale === 'et' ? `${name} katkestas ühenduse.` : `${name} disconnected.`);
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to revoke link' });
  }
});

// ── Teacher view API ──────────────────────────────────────────────────────────
router.get('/teacher/students', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const [students] = await db.execute(
      `SELECT lp.id AS passport_id, lp.display_name, ll.id AS link_id,
              (SELECT COUNT(*) FROM passport_goals pg WHERE pg.passport_id = lp.id AND pg.status='in_progress') AS active_goals,
              (SELECT MAX(kp.completed_at) FROM knobit_progress kp WHERE kp.passport_id = lp.id) AS last_active
       FROM learner_links ll
       JOIN learner_passports lp ON lp.id = ll.passport_id
       WHERE ll.linked_user_id = ? AND ll.role = 'teacher' AND ll.status = 'active'`,
      [userId]
    );

    // 7-day knobits-done sparkline per student, for the card view
    if (students.length) {
      const passportIds = students.map(s => s.passport_id);
      const placeholders = passportIds.map(() => '?').join(',');
      const [activityRows] = await db.execute(
        `SELECT passport_id, DATE_FORMAT(DATE(completed_at), '%Y-%m-%d') AS day, COUNT(*) AS n
         FROM knobit_progress
         WHERE phase_reached = 'done' AND passport_id IN (${placeholders})
           AND completed_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
         GROUP BY passport_id, DATE(completed_at)`,
        passportIds
      );
      const activityMap = {};
      activityRows.forEach(r => {
        if (!activityMap[r.passport_id]) activityMap[r.passport_id] = {};
        activityMap[r.passport_id][r.day] = Number(r.n);
      });
      const today = new Date();
      const localYMD = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const days = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(today); d.setDate(d.getDate() - (6 - i)); return localYMD(d);
      });
      students.forEach(s => {
        const sa = activityMap[s.passport_id] || {};
        s.activity7d = days.map(d => sa[d] || 0);
      });
    }

    res.json({ students });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load students' });
  }
});

router.get('/teacher/students/:passport_id', async (req, res) => {
  const userId = req.user?.id;
  const { passport_id } = req.params;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    // Verify teacher is linked to this student
    const [auth] = await db.execute(
      `SELECT id FROM learner_links WHERE passport_id = ? AND linked_user_id = ? AND role = 'teacher' AND status = 'active'`,
      [passport_id, userId]
    );
    if (!auth.length) return res.status(403).json({ error: 'Not linked to this student' });

    const [[passport]] = await db.execute(
      'SELECT display_name, about FROM learner_passports WHERE id = ?', [passport_id]
    );
    const [goals] = await db.execute(
      `SELECT g.*, n.label AS node_label, COALESCE(unk.percentage,0) AS progress
       FROM passport_goals g
       LEFT JOIN nodes n ON n.external_id = g.node_external_id
       LEFT JOIN user_node_knowledge unk ON unk.node_external_id = g.node_external_id AND unk.passport_id = g.passport_id
       WHERE g.passport_id = ? AND g.status = 'in_progress' ORDER BY g.created_at DESC`,
      [passport_id]
    );
    const [events] = await db.execute(
      `SELECT title, institution, event_date, type FROM passport_events
       WHERE passport_id = ? ORDER BY event_date DESC LIMIT 10`,
      [passport_id]
    );
    res.json({ passport, goals, events });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load student detail' });
  }
});

router.post('/teacher/students/:passport_id/goals', async (req, res) => {
  const userId = req.user?.id;
  const { passport_id } = req.params;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const { node_external_id, node_breadcrumb, target_date } = req.body;
  if (!node_external_id) return res.status(400).json({ error: 'node_external_id required' });
  try {
    const [auth] = await db.execute(
      `SELECT id FROM learner_links WHERE passport_id = ? AND linked_user_id = ? AND role = 'teacher' AND status = 'active'`,
      [passport_id, userId]
    );
    if (!auth.length) return res.status(403).json({ error: 'Not linked' });
    const [existing] = await db.execute(
      `SELECT id FROM passport_goals WHERE passport_id = ? AND node_external_id = ? AND status = 'in_progress'`,
      [passport_id, node_external_id]
    );
    if (existing.length) return res.json({ ok: true, duplicate: true, id: existing[0].id });
    const [r] = await db.execute(
      `INSERT INTO passport_goals (passport_id, text, node_external_id, node_breadcrumb, target_date, status, suggested_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'in_progress', ?, NOW())`,
      [passport_id, node_breadcrumb || node_external_id, node_external_id, node_breadcrumb || null, target_date || null, userId]
    );
    res.json({ ok: true, id: r.insertId });
  } catch (err) {
    res.status(500).json({ error: 'Failed to suggest goal' });
  }
});

// ── Parent view API ───────────────────────────────────────────────────────────
router.get('/parent/children', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const [children] = await db.execute(
      `SELECT lp.id AS passport_id, lp.display_name, lp.birth_year,
              (SELECT MAX(kp.completed_at) FROM knobit_progress kp WHERE kp.passport_id = lp.id) AS last_active
       FROM learner_links ll
       JOIN learner_passports lp ON lp.id = ll.passport_id
       WHERE ll.linked_user_id = ? AND ll.role = 'parent' AND ll.status = 'active'`,
      [userId]
    );

    // 7-day knobits-done sparkline per child, for the card view
    if (children.length) {
      const passportIds = children.map(c => c.passport_id);
      const placeholders = passportIds.map(() => '?').join(',');
      const [activityRows] = await db.execute(
        `SELECT passport_id, DATE_FORMAT(DATE(completed_at), '%Y-%m-%d') AS day, COUNT(*) AS n
         FROM knobit_progress
         WHERE phase_reached = 'done' AND passport_id IN (${placeholders})
           AND completed_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
         GROUP BY passport_id, DATE(completed_at)`,
        passportIds
      );
      const activityMap = {};
      activityRows.forEach(r => {
        if (!activityMap[r.passport_id]) activityMap[r.passport_id] = {};
        activityMap[r.passport_id][r.day] = Number(r.n);
      });
      const today = new Date();
      const localYMD = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const days = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(today); d.setDate(d.getDate() - (6 - i)); return localYMD(d);
      });
      children.forEach(c => {
        const ca = activityMap[c.passport_id] || {};
        c.activity7d = days.map(d => ca[d] || 0);
      });
    }

    res.json({ children });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load children' });
  }
});

// ── Per-child activity for the detail-view chart — adjustable time period ────
router.get('/parent/children/:passport_id/activity', async (req, res) => {
  const userId = req.user?.id;
  const { passport_id } = req.params;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  const period = ['7d', '30d', '90d'].includes(req.query.period) ? req.query.period : '30d';
  const days = period === '7d' ? 7 : period === '90d' ? 90 : 30;
  try {
    const [auth] = await db.execute(
      `SELECT id FROM learner_links WHERE passport_id = ? AND linked_user_id = ? AND role = 'parent' AND status = 'active'`,
      [passport_id, userId]
    );
    if (!auth.length) return res.status(403).json({ error: 'Not linked' });

    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - (days - 1));
    const fromStr = fromDate.getFullYear() + '-' + String(fromDate.getMonth() + 1).padStart(2, '0') + '-' + String(fromDate.getDate()).padStart(2, '0');

    const [doneRows] = await db.execute(
      `SELECT DATE_FORMAT(DATE(completed_at), '%Y-%m-%d') AS day, COUNT(*) AS n
       FROM knobit_progress
       WHERE phase_reached = 'done' AND passport_id = ? AND completed_at >= ?
       GROUP BY DATE(completed_at)`,
      [passport_id, fromStr]
    );

    // Time spent isn't recorded directly — estimated from gaps between
    // consecutive interaction timestamps within the same day, capped at 5
    // minutes per gap so overnight/away gaps don't inflate the total.
    const [timeRows] = await db.execute(
      `SELECT DATE_FORMAT(day, '%Y-%m-%d') AS day, SUM(LEAST(raw_gap, 300)) AS seconds
       FROM (
         SELECT DATE(created_at) AS day,
                TIMESTAMPDIFF(SECOND, LAG(created_at) OVER (PARTITION BY DATE(created_at) ORDER BY created_at), created_at) AS raw_gap
         FROM knobit_interactions
         WHERE passport_id = ? AND created_at >= ?
       ) t
       WHERE raw_gap IS NOT NULL
       GROUP BY day`,
      [passport_id, fromStr]
    );

    // Knowledge tests (the 4-tier diagnostic under a node) are a completely
    // separate flow from knobit_interactions - no per-question interaction
    // log is kept, only the final result (user_node_knowledge, source =
    // 'tested'). So a day spent only taking tests showed zero active time
    // above. Add a flat per-test estimate so that activity isn't invisible.
    const TEST_MINUTES_ESTIMATE = 4;
    const [testRows] = await db.execute(
      `SELECT DATE_FORMAT(DATE(updated_at), '%Y-%m-%d') AS day, COUNT(*) AS n
       FROM user_node_knowledge
       WHERE source = 'tested' AND passport_id = ? AND updated_at >= ?
       GROUP BY DATE(updated_at)`,
      [passport_id, fromStr]
    );

    const doneMap = {}; doneRows.forEach(r => { doneMap[r.day] = Number(r.n); });
    const timeMap = {}; timeRows.forEach(r => { timeMap[r.day] = Number(r.seconds); });
    const testMinutesMap = {}; testRows.forEach(r => { testMinutesMap[r.day] = Number(r.n) * TEST_MINUTES_ESTIMATE; });

    const today = new Date();
    const localYMD = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const series = Array.from({ length: days }, (_, i) => {
      const d = new Date(today); d.setDate(d.getDate() - (days - 1 - i));
      const key = localYMD(d);
      const minutes = Math.round((timeMap[key] || 0) / 60) + (testMinutesMap[key] || 0);
      return { date: key, knobitsDone: doneMap[key] || 0, minutes: minutes };
    });

    res.json({ period, series });
  } catch (err) {
    console.error('[api/parent/children/:id/activity]', err.message);
    res.status(500).json({ error: 'Failed to load activity' });
  }
});

router.get('/parent/children/:passport_id', async (req, res) => {
  const userId = req.user?.id;
  const { passport_id } = req.params;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const [auth] = await db.execute(
      `SELECT id FROM learner_links WHERE passport_id = ? AND linked_user_id = ? AND role = 'parent' AND status = 'active'`,
      [passport_id, userId]
    );
    if (!auth.length) return res.status(403).json({ error: 'Not linked' });

    // Same source of truth as the learner's own Õppija pass (GET /api/profile)
    // — Õpisündmused/Nutikus/Eesmärgid render identically for a parent.
    // Deliberately NOT including gameState here: Mäng stays personal to the
    // learner, not shown to parents.
    const locale = await getUserLocale(userId);
    const data = await _fetchFullPassport(passport_id, locale);
    res.json({
      passport: data.passport,
      goals: data.goals,
      events: data.events,
      competence: data.competence,
      mapKnowledge: data.mapKnowledge,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load child detail' });
  }
});

// ── Learning recommendations — "Start here" next nodes ───────────────────────
// Returns 5 L5 nodes, one per L1 subject domain, all within the Estonian Basic
// School 2023 filter (subset_id=1).  Priority: goal-siblings > recently-touched
// neighbourhood > random.  Deduplication and per-domain picking done in JS.
router.get('/recommendations/next-nodes', async (req, res) => {
  const passportId = req.user?.passport_id;
  if (!passportId) return res.json({ nodes: [] });
  try {
    const locale = await getUserLocale(req.user?.id);
    const [rows] = await db.execute(`
      SELECT
        n.external_id                        AS id,
        COALESCE(tr.label,  n.label)         AS label,
        COALESCE(tr4.label, p4.label)        AS parent_label,
        l1.external_id                       AS l1_ext,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM passport_goals pg2
            JOIN nodes gn ON gn.external_id = pg2.node_external_id AND gn.level = 5
            WHERE pg2.passport_id = ? AND pg2.status = 'in_progress'
              AND gn.parent_id = p4.id AND gn.external_id != n.external_id
          ) THEN 1
          WHEN EXISTS (
            SELECT 1 FROM knobit_progress kp2
            JOIN knobits k2 ON k2.id = kp2.knobit_id
            WHERE k2.node_id IN (SELECT id FROM nodes WHERE parent_id = p4.id)
              AND kp2.passport_id = ? AND kp2.completed_at > DATE_SUB(NOW(), INTERVAL 14 DAY)
          ) THEN 2
          ELSE 3
        END AS priority
      FROM nodes n
      JOIN nodes p4 ON p4.id = n.parent_id
      JOIN nodes p3 ON p3.id = p4.parent_id
      JOIN nodes p2 ON p2.id = p3.parent_id
      JOIN nodes l1 ON l1.id = p2.parent_id
      LEFT JOIN node_translations tr  ON tr.node_external_id  = n.external_id  AND tr.locale = ?
      LEFT JOIN node_translations tr4 ON tr4.node_external_id = p4.external_id AND tr4.locale = ?
      WHERE n.level = 5 AND n.is_active = 1
        AND EXISTS (
          SELECT 1 FROM knowledge_subset_nodes ksn
          WHERE ksn.subset_id = 1
            AND ksn.node_id IN (p4.id, p3.id, p2.id, l1.id)
        )
        AND NOT EXISTS (
          SELECT 1 FROM knobit_progress kp
          JOIN knobits k ON k.id = kp.knobit_id
          WHERE k.node_id = n.id AND kp.passport_id = ?
        )
      ORDER BY priority ASC, RAND()
      LIMIT 100
    `, [passportId, passportId, locale, locale, passportId]);

    // One chip per L1 subject domain, preserving priority order
    const seen = new Set();
    const nodes = [];
    for (const row of rows) {
      if (!seen.has(row.l1_ext) && nodes.length < 5) {
        seen.add(row.l1_ext);
        nodes.push({
          id:         row.id,
          label:      row.label,
          breadcrumb: row.parent_label ? row.parent_label + ' › ' + row.label : row.label
        });
      }
    }

    res.json({ nodes });
  } catch (err) {
    console.error('[recommendations]', err.message);
    res.json({ nodes: [] });
  }
});

module.exports = router;
