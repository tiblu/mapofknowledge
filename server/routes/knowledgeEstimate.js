// ══════════════════════════════════════════════════════════════════════════
// KNOWLEDGE ESTIMATION — server/routes/knowledgeEstimate.js
// ──────────────────────────────────────────────────────────────────────────
// Mounted at /api/knowledge-estimate. Lets a learner enter previous
// qualifications and estimates their "My Knowledge" map from them — see
// docs/orientation.md's "Knowledge estimation" section for the full design
// history (why L4-then-L5 two-pass matching, why retention tiers, why the
// review-and-approve step exists).
//
// Two-step, stateless flow:
//   POST /prepare — inserts any new qualifications, runs the LLM estimation
//                   for every not-yet-estimated qualification on the
//                   passport (old ones included, not just this session's),
//                   returns the full candidate list. Writes NOTHING to
//                   user_node_knowledge and does not mark anything estimated
//                   yet — the client shows this list for the user to review.
//   POST /commit  — the client echoes back only the leaves the user left
//                   toggled on; this writes those (only where the node is
//                   still at 0%), logs every write to knowledge_estimate_log
//                   for manual rollback if needed, and marks the credential
//                   ids the client echoes back as knowledge_estimated = 1.
// ══════════════════════════════════════════════════════════════════════════
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const llm     = require('../services/llm');
const { updateAncestorKnowledge } = require('../services/nodeKnowledge');
const llmRateLimit = require('../middleware/llmRateLimit');

// Mirrors getUserLocale in api.js/auth.js — not imported since api.js only
// exports its router.
async function _getUserLocale(userId) {
  if (!userId) return 'en';
  try {
    const [rows] = await db.execute(
      'SELECT value FROM user_settings WHERE user_id = ? AND key_name = ?',
      [userId, 'ui_locale']
    );
    return (rows.length && rows[0].value) ? rows[0].value : 'en';
  } catch { return 'en'; }
}

const MAX_TITLE_LEN  = 255;
const MAX_ISSUER_LEN = 255;
const MAX_DETAILS_LEN = 500;

router.post('/prepare', llmRateLimit, async (req, res) => {
  const passportId = req.user?.passport_id;
  const userId     = req.user?.id;
  if (!passportId) return res.status(400).json({ error: 'No passport' });

  const newQualifications = Array.isArray(req.body.newQualifications) ? req.body.newQualifications : [];

  try {
    // ── Insert any newly-entered qualifications ──────────────────────────
    for (const q of newQualifications) {
      const title = typeof q.title === 'string' ? q.title.trim().slice(0, MAX_TITLE_LEN) : '';
      if (!title) continue;
      const issuer  = typeof q.issuer === 'string' ? q.issuer.trim().slice(0, MAX_ISSUER_LEN) || null : null;
      const details = typeof q.details === 'string' ? q.details.trim().slice(0, MAX_DETAILS_LEN) || null : null;
      const year = parseInt(q.year, 10);
      const awardedDate = (Number.isInteger(year) && year > 1900 && year <= new Date().getFullYear() + 1)
        ? `${year}-01-01` : null;
      await db.execute(
        `INSERT INTO passport_credentials (passport_id, type, title, issuer, details, awarded_date, sort_order)
         VALUES (?, 'qualification', ?, ?, ?, ?, 0)`,
        [passportId, title, issuer, details, awardedDate]
      );
    }

    // ── Gather every not-yet-estimated qualification on this passport —
    //    old ones the user already had, plus whatever was just added above.
    const [pending] = await db.execute(
      `SELECT id, title, issuer, details, awarded_date FROM passport_credentials
       WHERE passport_id = ? AND type = 'qualification' AND knowledge_estimated = 0`,
      [passportId]
    );
    if (!pending.length) return res.json({ credentialIds: [], candidates: [] });

    const currentYear = new Date().getFullYear();
    const qualifications = pending.map(p => ({
      title: p.title,
      issuer: p.issuer,
      details: p.details,
      year: p.awarded_date ? new Date(p.awarded_date).getFullYear() : currentYear,
    }));

    // ── Pass 1: cheap L4-level candidate scan ────────────────────────────
    const [l4rows] = await db.execute(`
      SELECT n4.external_id, n4.label AS l4, n3.label AS l3, n2.label AS l2, n1.label AS l1
      FROM nodes n4
      LEFT JOIN nodes n3 ON n3.id = n4.parent_id
      LEFT JOIN nodes n2 ON n2.id = n3.parent_id
      LEFT JOIN nodes n1 ON n1.id = n2.parent_id
      WHERE n4.level = 4 AND n4.is_active = 1
    `);
    const crumbOf = {}, domainOf = {};
    l4rows.forEach(r => {
      crumbOf[r.external_id] = [r.l1, r.l2, r.l3, r.l4].filter(Boolean).join(' > ');
      domainOf[r.external_id] = r.l1 || 'Other';
    });
    const l4List = l4rows.map(r => `${r.external_id}\t${crumbOf[r.external_id]}`).join('\n');

    const pass1 = await llm.estimateKnowledgeAreas(qualifications, l4List, userId);

    // ── Fetch L5 children of every candidate L4, per qualification ───────
    const perQualGroups = {};
    for (const q of qualifications) {
      const r1 = (pass1.results || []).find(r => r.qualification === q.title) || { matches: [] };
      const groups = [];
      for (const m of r1.matches || []) {
        const [l5rows] = await db.execute(
          `SELECT external_id, label FROM nodes WHERE parent_id = (SELECT id FROM nodes WHERE external_id = ?) AND level = 5`,
          [m.id]
        );
        if (l5rows.length) groups.push({ l4Id: m.id, crumb: crumbOf[m.id], domain: domainOf[m.id], why: m.why, leaves: l5rows });
      }
      perQualGroups[q.title] = groups;
    }

    // ── Pass 2: leaf-level plausibility + retention tier ─────────────────
    const pass2 = await llm.estimateKnowledgeLeaves(qualifications, perQualGroups, userId);

    // ── Resolve to a flat candidate list, deduped, skipping nodes that
    //    already have a non-zero percentage (nothing to estimate there). ──
    const leafInfo = {}; // external_id -> { label, domain, crumb }
    Object.values(perQualGroups).forEach(groups => groups.forEach(g =>
      g.leaves.forEach(l => { leafInfo[l.external_id] = { label: l.label, domain: g.domain, crumb: g.crumb }; })
    ));

    const byLeaf = new Map(); // external_id -> best {percentage, retention, confidence}
    for (const q of qualifications) {
      const r2 = (pass2.results || []).find(r => r.qualification === q.title) || { leaves: [] };
      for (const l of r2.leaves || []) {
        if (!leafInfo[l.id]) continue;
        const pct = llm.knowledgeEstimatePercentage(q.year, l.retention);
        const existing = byLeaf.get(l.id);
        if (!existing || pct > existing.percentage) {
          byLeaf.set(l.id, { percentage: pct, retention: l.retention, confidence: l.confidence });
        }
      }
    }

    const candidateIds = [...byLeaf.keys()];
    let alreadyKnown = new Set();
    if (candidateIds.length) {
      const placeholders = candidateIds.map(() => '?').join(',');
      const [existingRows] = await db.execute(
        `SELECT node_external_id FROM user_node_knowledge WHERE passport_id = ? AND node_external_id IN (${placeholders}) AND percentage > 0`,
        [passportId, ...candidateIds]
      );
      alreadyKnown = new Set(existingRows.map(r => r.node_external_id));
    }

    const locale = await _getUserLocale(userId);
    let translations = {};
    if (locale !== 'en' && candidateIds.length) {
      const placeholders = candidateIds.map(() => '?').join(',');
      const [trRows] = await db.execute(
        `SELECT node_external_id, label FROM node_translations WHERE locale = ? AND node_external_id IN (${placeholders})`,
        [locale, ...candidateIds]
      );
      trRows.forEach(r => { translations[r.node_external_id] = r.label; });
    }

    const candidates = candidateIds
      .filter(id => !alreadyKnown.has(id))
      .map(id => {
        const info = leafInfo[id];
        const v = byLeaf.get(id);
        return {
          id,
          label: translations[id] || info.label,
          domain: info.domain,
          breadcrumb: info.crumb + ' > ' + info.label,
          percentage: v.percentage,
          retention: v.retention,
          confidence: v.confidence,
        };
      })
      .sort((a, b) => b.percentage - a.percentage);

    res.json({ credentialIds: pending.map(p => p.id), candidates });
  } catch (err) {
    console.error('[knowledge-estimate/prepare]', err.message);
    res.status(500).json({ error: 'estimate_failed' });
  }
});

router.post('/commit', async (req, res) => {
  const passportId = req.user?.passport_id;
  if (!passportId) return res.status(400).json({ error: 'No passport' });

  const credentialIds = Array.isArray(req.body.credentialIds) ? req.body.credentialIds.filter(Number.isInteger) : [];
  const approved = Array.isArray(req.body.approved) ? req.body.approved : [];

  try {
    let written = 0;
    for (const leaf of approved) {
      const nodeId = typeof leaf.id === 'string' ? leaf.id : null;
      const pct = parseInt(leaf.percentage, 10);
      const tier = ['core', 'practiced', 'specialized'].includes(leaf.retention) ? leaf.retention : 'practiced';
      if (!nodeId || !Number.isInteger(pct) || pct <= 0 || pct > 100) continue;

      const [nodeRows] = await db.execute('SELECT id AS db_id FROM nodes WHERE external_id = ?', [nodeId]);
      if (!nodeRows.length) continue;

      const [existing] = await db.execute(
        'SELECT percentage FROM user_node_knowledge WHERE passport_id = ? AND node_external_id = ?',
        [passportId, nodeId]
      );
      if (existing.length && existing[0].percentage > 0) continue; // only ever fill in nodes still at 0%

      await db.execute(
        `INSERT INTO user_node_knowledge (passport_id, node_external_id, percentage, source, updated_at)
         VALUES (?, ?, ?, 'self_reported', NOW())
         ON DUPLICATE KEY UPDATE percentage = VALUES(percentage), source = 'self_reported', updated_at = NOW()`,
        [passportId, nodeId, pct]
      );
      await db.execute(
        `INSERT INTO knowledge_estimate_log (passport_id, credential_id, node_external_id, percentage, retention_tier)
         VALUES (?, NULL, ?, ?, ?)`,
        [passportId, nodeId, pct, tier]
      );
      written++;
      updateAncestorKnowledge(passportId, nodeId).catch(() => {});
    }

    if (credentialIds.length) {
      const placeholders = credentialIds.map(() => '?').join(',');
      await db.execute(
        `UPDATE passport_credentials SET knowledge_estimated = 1 WHERE passport_id = ? AND id IN (${placeholders})`,
        [passportId, ...credentialIds]
      );
    }

    res.json({ ok: true, written });
  } catch (err) {
    console.error('[knowledge-estimate/commit]', err.message);
    res.status(500).json({ error: 'commit_failed' });
  }
});

module.exports = router;
