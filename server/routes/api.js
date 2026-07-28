const express = require('express');
const router  = express.Router();
const db      = require('../db');
const llm     = require('../services/llm');
const game    = require('../services/game');
const { notify } = require('../services/notifications');
const { buildKnobitDocx } = require('../services/knobitDocx');

// ── User locale helper ───────────────────────────────────────────────────────
async function getUserLocale(userId) {
  if (!userId) return 'en';
  try {
    const [rows] = await db.execute(
      'SELECT value FROM user_settings WHERE user_id = ? AND key_name = ?',
      [userId, 'ui_locale']
    );
    return (rows.length && rows[0].value) ? rows[0].value : 'en';
  } catch { return 'en'; }
}

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

// ── In-memory map cache per locale (10k+ nodes — cache after first DB load) ───
const mapCaches = {};

router.get('/map', async (req, res) => {
  try {
    const locale = await getUserLocale(req.user?.id);
    if (mapCaches[locale]) return res.json(mapCaches[locale]);

    const translatedNodeSql = (layer) =>
      locale === 'en'
        ? [`SELECT external_id AS id, label, level
            FROM nodes WHERE layer = ? AND is_active = 1`, [layer]]
        : [`SELECT n.external_id AS id, COALESCE(tr.label, n.label) AS label, n.level
            FROM nodes n
            LEFT JOIN node_translations tr
              ON tr.node_external_id = n.external_id AND tr.locale = ?
            WHERE n.layer = ? AND n.is_active = 1`, [locale, layer]];

    const [baseNodes]     = await db.execute(...translatedNodeSql('foundational'));
    const [emergentNodes] = await db.execute(...translatedNodeSql('emergent'));

    const [baseEdges] = await db.execute(
      `SELECT s.external_id AS source, t.external_id AS target
       FROM edges e
       JOIN nodes s ON e.source_node_id = s.id
       JOIN nodes t ON e.target_node_id = t.id
       WHERE e.edge_type = 'hierarchy'`
    );
    const [emergentEdges] = await db.execute(
      `SELECT s.external_id AS source, t.external_id AS target, e.edge_type
       FROM edges e
       JOIN nodes s ON e.source_node_id = s.id
       JOIN nodes t ON e.target_node_id = t.id
       WHERE e.edge_type IN ('hierarchy','draws_from')
         AND (s.layer = 'emergent' OR t.layer = 'emergent')`
    );

    // Frontend expects 'hierarchical' for emergent hierarchy edges
    const mappedEmergentEdges = emergentEdges.map(e => ({
      ...e,
      edge_type: e.edge_type === 'hierarchy' ? 'hierarchical' : e.edge_type,
    }));

    mapCaches[locale] = {
      base:     { nodes: baseNodes,     edges: baseEdges },
      emergent: { nodes: emergentNodes, edges: mappedEmergentEdges },
    };

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

    if (node.overview && locale === 'en') return res.json({ overview: node.overview });

    const domain   = await getNodeDomain(node.db_id);
    const overview = await llm.generateOverview(node.label, domain, node.level, locale, req.user?.id);
    if (locale === 'en') {
      await db.execute('UPDATE nodes SET overview = ? WHERE external_id = ?', [overview, id]);
    }
    res.json({ overview });
  } catch (err) {
    console.error('[api/nodes/overview]', err.message);
    res.status(500).json({ error: 'Failed to generate overview' });
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
// Per-locale in-memory cache; cleared on server restart.
// Falls back to 'en' for any keys missing in the requested locale.
const _stringsCache = {};

router.get('/strings', async (req, res) => {
  const locale = (req.query.locale || 'en').replace(/[^a-zA-Z-]/g, '').slice(0, 10) || 'en';
  if (_stringsCache[locale]) {
    return res.set('Cache-Control', 'public, max-age=300').json(_stringsCache[locale]);
  }
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
    _stringsCache[locale] = out;
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
    const [rows] = await db.execute(
      `SELECT n.external_id AS nodeId, n.label,
              COUNT(k.id)          AS total,
              COUNT(kp.knobit_id)  AS done,
              MAX(kp.completed_at) AS last_activity
       FROM knobits k
       JOIN nodes n ON k.node_id = n.id
       LEFT JOIN knobit_progress kp
              ON k.id = kp.knobit_id AND kp.passport_id = ?
       GROUP BY n.id, n.external_id, n.label
       HAVING done > 0 AND done < total
       ORDER BY last_activity DESC
       LIMIT 1`,
      [passportId]
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
    const [nodes] = await db.execute(
      'SELECT id AS db_id, level, label FROM nodes WHERE external_id = ?', [id]
    );
    if (!nodes.length) return res.status(404).json({ error: 'Node not found' });
    const { db_id, level, label } = nodes[0];

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
      const eventTitle = pct >= 100 ? `Marked as known: ${label}` : `Unmarked as known: ${label}`;
      db.execute(
        `INSERT INTO passport_events (passport_id, event_date, title, institution, node_external_id, type, sort_order)
         VALUES (?, CURDATE(), ?, 'Map of Knowledge · KaiQ Platform', ?, 'activity', 0)`,
        [passportId, eventTitle, id]
      ).catch(() => {});
      if (pct >= 100) {
        notify(req.user?.id, 'knowledge_marked', `Marked as known: ${label}`,
          `Added to your Learner Passport knowledge map.`, id);
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
      'SELECT id AS db_id, label, level FROM nodes WHERE external_id = ?', [id]
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
      const generated  = await llm.generateKnobits(node.label, domain, breadcrumb, req.user?.id);
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
        await db.execute(
          `INSERT INTO passport_events
             (passport_id, event_date, title, institution, result, node_external_id, type, sort_order)
           VALUES (?, CURDATE(), ?, 'Map of Knowledge · KaiQ Platform', NULL, ?, 'activity', 0)`,
          [passportId, `Started learning: ${node.label}`, id]
        ).catch(() => {});
      }
    }

    // Translate titles for non-English locales
    if (locale !== 'en') {
      knobits = await llm.translateKnobitTitles(knobits, locale, req.user?.id);
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
async function _runStream(streamFn, res, onDone) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  // Keepalive: Apache buffers SSE; send every 3s so it sees traffic before timing out.
  const keepalive = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 3000);
  let full = '';
  const write = (chunk) => { full += chunk; try { res.write('data: ' + JSON.stringify({ t: chunk }) + '\n\n'); } catch (_) {} };
  // writeStatus sends an out-of-band status frame — it never touches `full`, so it
  // can't pollute the accumulated text that onDone persists. streamFn closures that
  // don't take a second param silently ignore the extra arg.
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
    if (writeStatus) writeStatus('generating_text');
    const raw = await generateFn();
    if (writeStatus) writeStatus('checking_language');
    const { text } = await llm.editTranslatedText({ text: raw }, locale, uid);
    await _fakeStreamText(text, write, res);
  };
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

// The 'ask' request phase isn't itself a valid knobit_interactions.phase ENUM
// value — an ask-bar question is asked *during* one of the four real phases,
// so it's persisted under that phase instead. `action` carries which one.
const _KNOBIT_PHASES = ['explain', 'demonstrate', 'practice', 'meaning'];
function _askDbPhase(action) {
  return _KNOBIT_PHASES.includes(action) ? action : 'explain';
}

// ── Persist a knobit lesson block for mid-lesson resume/grounding ───────────
async function _saveInteraction(passportId, knobitId, phase, blockType, blockIndex, choiceMade, answerText, content) {
  if (!passportId) return;
  await db.execute(
    `INSERT INTO knobit_interactions (passport_id, knobit_id, phase, block_type, block_index, choice_made, answer_text, content)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [passportId, knobitId, phase, blockType, blockIndex, choiceMade || null, answerText || null, content]
  ).catch((err) => console.error('[knobit_interactions]', err.message));
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
      `SELECT k.title AS knobitTitle,
              COALESCE(trn.label, n.label) AS nodeLabel
       FROM knobits k
       JOIN nodes n ON k.node_id = n.id
       LEFT JOIN node_translations trn ON trn.node_external_id = n.external_id AND trn.locale = ?
       WHERE k.id = ?`,
      [locale, knobitId]
    );
    if (!krows.length) return res.status(404).json({ error: 'Knobit not found' });
    let { knobitTitle, nodeLabel } = krows[0];

    if (locale !== 'en') {
      const translated = await llm.translateKnobitTitles([{ title: knobitTitle }], locale, req.user?.id);
      if (translated[0]?.title) knobitTitle = translated[0].title;
    }

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
      `SELECT k.node_id, n.external_id AS nodeExtId, n.label AS nodeLabel, k.locale, k.title AS knobitTitle
       FROM knobits k JOIN nodes n ON k.node_id = n.id
       WHERE k.id = ?`,
      [knobitId]
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

      const userId = req.user?.id;
      const [[{ totalEver }]] = await db.execute(
        `SELECT COUNT(*) AS totalEver FROM knobit_progress
         WHERE passport_id = ? AND phase_reached = 'done'`,
        [passportId]
      );

      // Per-knobit notification
      if (totalEver === 1) {
        notify(userId, 'knobit_complete', 'First knobit mastered!',
          `You completed your very first learning step: "${knobitTitle}". An exciting journey begins!`, nodeExtId);
      } else {
        notify(userId, 'knobit_complete', `Knobit complete: ${knobitTitle}`,
          `Topic: ${nodeLabel}`, nodeExtId);
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
        const credTitle = `${nodeLabel} — Completed`;
        const [[existing]] = await db.execute(
          `SELECT id FROM passport_credentials
           WHERE passport_id = ? AND type = 'platform' AND title = ?`,
          [passportId, credTitle]
        );
        if (!existing) {
          const crypto = require('crypto');
          const hash = crypto.createHash('sha256')
            .update(`${passportId}-${nodeExtId}-${Date.now()}`)
            .digest('hex')
            .substring(0, 16);
          await db.execute(
            `INSERT INTO passport_credentials
               (passport_id, type, title, issuer, awarded_date, score_pct, threshold_pct,
                blockchain_hash, sort_order)
             VALUES (?, 'platform', ?, 'Map of Knowledge · KaiQ Platform', CURDATE(), 100, 80, ?, 0)`,
            [passportId, credTitle, '0x' + hash]
          );
          await db.execute(
            `INSERT INTO passport_events
               (passport_id, event_date, title, institution, result, node_external_id, type, sort_order)
             VALUES (?, CURDATE(), ?, 'Map of Knowledge · KaiQ Platform', 'Score: 100%', ?, 'assessment', 0)`,
            [passportId, `Completed: ${nodeLabel}`, nodeExtId]
          );
          notify(userId, 'unit_complete', `${nodeLabel} — fully mastered!`,
            `You've completed every learning step for this topic.`, nodeExtId);
          notify(userId, 'credential', `New credential: ${credTitle}`,
            `A platform credential has been added to your Learner Passport.`, nodeExtId);
        }
      }

      // ── Gamification ───────────────────────────────────────────────────────
      game.awardLumens(passportId, userId, 10, 'knobit_complete', knobitId).catch(() => {});
      if (done >= total && total > 0) {
        game.awardLumens(passportId, userId, 25, 'node_all_knobits', nodeExtId).catch(() => {});
      }
      game.checkAchievements(passportId, userId, 'knobit_complete', { totalEver }).catch(() => {});
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

    // L4/L5 knowledge nodes with full breadcrumb
    const [mapKnowledgeRaw] = await db.execute(
      `SELECT n.label, n.level, u.percentage, u.source,
              p1.label AS p1, p2.label AS p2, p3.label AS p3, p4.label AS p4
       FROM user_node_knowledge u
       JOIN nodes n ON n.external_id = u.node_external_id
       LEFT JOIN nodes p1 ON p1.id = n.parent_id
       LEFT JOIN nodes p2 ON p2.id = p1.parent_id
       LEFT JOIN nodes p3 ON p3.id = p2.parent_id
       LEFT JOIN nodes p4 ON p4.id = p3.parent_id
       WHERE u.passport_id = ? AND n.level IN (4,5) AND u.percentage > 0
       ORDER BY u.percentage DESC, n.level DESC
       LIMIT 200`,
      [passportId]
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

    const [goals] = await db.execute(
      `SELECT * FROM passport_goals WHERE passport_id = ?
       ORDER BY status ASC, created_at DESC`,
      [passportId]
    );

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

    res.json({
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
    });
  } catch (err) {
    console.error('[api/profile]', err.message);
    res.status(500).json({ error: 'Failed to load profile' });
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
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'text required' });
  try {
    const [result] = await db.execute(
      `INSERT INTO passport_goals (passport_id, text, status, created_at) VALUES (?, ?, 'in_progress', NOW())`,
      [passportId, text.trim()]
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
    const [goals] = await db.execute(
      'SELECT text FROM passport_goals WHERE id = ? AND passport_id = ?',
      [req.params.id, passportId]
    );
    await db.execute(
      `UPDATE passport_goals SET status='completed', completed_at=NOW() WHERE id=? AND passport_id=?`,
      [req.params.id, passportId]
    );
    if (goals.length) {
      notify(req.user?.id, 'goal_complete', 'Goal achieved!',
        `You completed: "${goals[0].text}"`);
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
      `SELECT id, type, title, body, icon_color, node_external_id, is_read, created_at
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
    res.json(result);
  } catch (err) {
    console.error('[api/test/question]', err.message);
    res.status(500).json({ error: 'Failed to generate question' });
  }
});

// ── Persist a Q4 test-completion result (score, event log, notification, gamification) ──
async function _saveTestResult(passportId, userId, nodeId, label, evaluation) {
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
  await db.execute(
    `INSERT INTO passport_events
       (passport_id, event_date, title, institution, result, node_external_id, type, sort_order)
     VALUES (?, CURDATE(), ?, 'Map of Knowledge · KaiQ Platform', ?, ?, 'assessment', 0)`,
    [passportId, `Knowledge test: ${label}`, `Score: ${evaluation.finalScore}%`, nodeId]
  );
  notify(userId, 'test_result', `Test result: ${label}`,
    `You scored ${evaluation.finalScore}% on the knowledge diagnostic.`, nodeId);
  // ── Gamification ───────────────────────────────────────────────────────────
  const score      = evaluation.finalScore;
  const lumensBase = score === 100 ? 100 : score >= 80 ? 50 : 20;
  const reason      = score === 100 ? 'test_perfect' : 'test_complete';
  game.awardLumens(passportId, userId, lumensBase, reason, nodeId).catch(() => {});
  game.checkAchievements(passportId, userId, 'test_complete', { score }).catch(() => {});
}

// ── 4-tier diagnostic: evaluate answer ───────────────────────────────────────
router.post('/test/evaluate', async (req, res) => {
  const { nodeId, questionNum, question, options, userAnswer, correctIndex, history = [], stream: wantStream = false } = req.body;
  const passportId = req.user?.passport_id;

  try {
    const [nodes] = await db.execute(
      'SELECT id AS db_id, label, level FROM nodes WHERE external_id = ?', [nodeId]
    );
    if (!nodes.length) return res.status(404).json({ error: 'Node not found' });
    const { db_id, label } = nodes[0];
    const breadcrumb = await getNodeBreadcrumb(db_id);
    const locale = await getUserLocale(req.user?.id);

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
        if (questionNum !== 4 || !passportId) return;
        try {
          const cleaned = fullText.trim()
            .replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
          const evaluation = JSON.parse(cleaned);
          await _saveTestResult(passportId, req.user?.id, nodeId, label, evaluation);
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
      await _saveTestResult(passportId, req.user?.id, nodeId, label, evaluation);
    }

    res.json(evaluation);
  } catch (err) {
    console.error('[api/test/evaluate]', err.message);
    res.status(500).json({ error: 'Evaluation failed' });
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

module.exports = router;
