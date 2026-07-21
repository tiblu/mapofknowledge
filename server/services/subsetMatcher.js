/* ═══════════════════════════════════════════════════════════════
   SUBSET MATCHER
   Three-stage pipeline: exact → breadcrumb → LLM fallback.
   Returns staging rows; never writes to DB itself.

   Locale-aware throughout: node_translations is keyed by external_id
   (not nodes.id) and only holds rows for non-English locales, so
   COALESCE(tr.label, n.label) against locale=? correctly falls back to
   the English base label with zero special-casing for locale='en'.
   ═══════════════════════════════════════════════════════════════ */

const Anthropic = require('@anthropic-ai/sdk');
const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Separate Anthropic client instance from server/services/llm.js — needs its
// own copy of the billing-failure alert wrapper (see llm.js for why).
const { _wrapWithBillingAlert } = require('./_anthropicAlert');
_wrapWithBillingAlert(client);

// ── Public entry point ────────────────────────────────────────────────────────
// terms: [{ label: string, breadcrumb?: string }]
// Returns: staging row objects (not yet inserted — caller inserts them)
async function matchTerms(terms, db, locale) {
  const results = [];
  for (const term of terms) {
    const row = await _matchOne(term.label, term.breadcrumb || null, locale, db);
    results.push({ input_term: term.label, input_breadcrumb: term.breadcrumb || null, ...row });
  }
  return results;
}

// ── Stage routing ─────────────────────────────────────────────────────────────
async function _matchOne(label, breadcrumb, locale, db) {
  const exact = await _exactMatch(label, locale, db);

  if (exact.length === 1) {
    const node = exact[0];
    return { matched_node_id: node.id, match_method: 'exact', confidence: 100, status: 'accepted', candidates_json: null };
  }

  if (exact.length > 1) {
    if (breadcrumb) {
      const resolved = await _resolveByBreadcrumb(exact, breadcrumb, locale, db);
      if (resolved) {
        return { matched_node_id: resolved.id, match_method: 'breadcrumb', confidence: 95, status: 'accepted', candidates_json: null };
      }
    }
    return {
      matched_node_id: null, match_method: null, confidence: null, status: 'ambiguous',
      candidates_json: JSON.stringify(exact.map(n => ({ id: n.id, label: n.label, level: n.level }))),
    };
  }

  // No exact match — fuzzy search then LLM
  return _fuzzyAndLLM(label, locale, db);
}

// ── Stage 1: exact ────────────────────────────────────────────────────────────
async function _exactMatch(label, locale, db) {
  const [rows] = await db.execute(
    `SELECT n.id, COALESCE(tr.label, n.label) AS label, n.level
     FROM nodes n
     LEFT JOIN node_translations tr ON tr.node_external_id = n.external_id AND tr.locale = ?
     WHERE LOWER(COALESCE(tr.label, n.label)) = LOWER(?) AND n.is_active = 1`,
    [locale, label]
  );
  return rows;
}

// ── Stage 2: breadcrumb disambiguation ───────────────────────────────────────
async function _resolveByBreadcrumb(candidates, breadcrumb, locale, db) {
  const parts = breadcrumb.split('>').map(s => s.trim().toLowerCase()).filter(Boolean);
  for (const candidate of candidates) {
    const ancestors = await _getAncestors(candidate.id, locale, db);
    const ancestorLabels = ancestors.map(a => a.label.toLowerCase());
    if (parts.some(p => ancestorLabels.includes(p))) return candidate;
  }
  return null;
}

async function _getAncestors(nodeId, locale, db) {
  const [rows] = await db.execute(
    `WITH RECURSIVE anc AS (
       SELECT id, external_id, label, parent_id FROM nodes WHERE id = ?
       UNION ALL
       SELECT n.id, n.external_id, n.label, n.parent_id FROM nodes n JOIN anc a ON n.id = a.parent_id
     )
     SELECT anc.id, COALESCE(tr.label, anc.label) AS label
     FROM anc
     LEFT JOIN node_translations tr ON tr.node_external_id = anc.external_id AND tr.locale = ?`,
    [nodeId, locale]
  );
  return rows;
}

// ── Stage 3: fuzzy search + LLM ──────────────────────────────────────────────
async function _fuzzyAndLLM(label, locale, db) {
  const firstWord = label.split(' ')[0];
  const [fuzzy] = await db.execute(
    `SELECT n.id, COALESCE(tr.label, n.label) AS label, n.level
     FROM nodes n
     LEFT JOIN node_translations tr ON tr.node_external_id = n.external_id AND tr.locale = ?
     WHERE COALESCE(tr.label, n.label) LIKE ? AND n.is_active = 1
     LIMIT 12`,
    [locale, '%' + firstWord + '%']
  );

  if (!fuzzy.length) {
    return { matched_node_id: null, match_method: null, confidence: null, status: 'no_match', candidates_json: null };
  }

  const suggestion = await _askLLM(label, fuzzy);
  const candidatesJson = JSON.stringify(fuzzy.map(n => ({ id: n.id, label: n.label, level: n.level })));

  if (!suggestion) {
    return { matched_node_id: null, match_method: null, confidence: null, status: 'no_match', candidates_json: candidatesJson };
  }

  return { matched_node_id: suggestion.id, match_method: 'llm', confidence: 70, status: 'pending', candidates_json: candidatesJson };
}

async function _askLLM(inputTerm, candidates) {
  const list = candidates.map(c => `"${c.label}"`).join(', ');
  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 60,
      messages: [{
        role: 'user',
        content: `KnoBitz nodes: ${list}\n\nWhich node best represents: "${inputTerm}"?\nReply with the exact node label only, or "no match".`,
      }],
    });
    const answer = msg.content[0].text.trim().replace(/^"|"$/g, '');
    if (answer.toLowerCase() === 'no match') return null;
    return candidates.find(c => c.label.toLowerCase() === answer.toLowerCase()) || null;
  } catch {
    return null;
  }
}

module.exports = { matchTerms };
