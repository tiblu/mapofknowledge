// Single point-of-truth learner context ("WHOIS") for every LLM call — see
// the learner_whois table (server/db/migrate.js) for the storage shape.
// Replaces the old inconsistent mix: Anne got a full passport-text render,
// some knobit-generation calls got a small profileBlock, others got nothing
// about the learner at all.
//
// Two parts per entry:
//   core_text      — deterministic, computed instantly from passport fields
//                     (identity/interests/values). No LLM call.
//   narrative_text — one LLM call, ~400-600 tokens, fed the FULL passport
//                     plus the PRIOR narrative so it reads as one
//                     continuously-updated dossier, not a fresh essay every
//                     time.
//
// Regeneration is event-triggered (see refreshWhoisIfDue's callers across
// server/routes/*) and cooldown-gated so a burst of activity (e.g.
// finishing 10 knobits back to back) doesn't fire 10 LLM calls — always
// fire-and-forget, never blocks the request that triggered it.
const db = require('../db');
const llm = require('./llm');
const { fetchFullPassport } = require('./passportData');
const { renderPassportText } = require('./passportText');

const COOLDOWN_MS = 30 * 60 * 1000;

const HATE = /\b(nazi|white.suprem|nigger|faggot|kike|slut|whore|chink|spic)\b/i;
function _safe(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || HATE.test(s)) return null;
  return s;
}

function _buildCoreText(passportData) {
  const p = passportData.passport;
  if (!p) return '';
  const parts = [];
  if (p.display_name) parts.push(`Name: ${p.display_name}`);
  if (p.birth_year) {
    const age = new Date().getFullYear() - p.birth_year;
    if (age > 3 && age < 120) parts.push(`Age: ${age}`);
  }
  const loc = _safe(p.location);
  if (loc) parts.push(`Location: ${loc}`);
  const cult = _safe(p.cultural_background);
  if (cult) parts.push(`Cultural background: ${cult}`);

  const tags = passportData.tags || [];
  const interests = tags.filter(t => t.type === 'interest').map(t => _safe(t.text)).filter(Boolean).slice(0, 8);
  const values = tags.filter(t => t.type === 'value').map(t => _safe(t.text)).filter(Boolean).slice(0, 8);
  if (interests.length) parts.push(`Interests: ${interests.join(', ')}`);
  if (values.length) parts.push(`Values: ${values.join(', ')}`);

  return parts.length ? parts.join('. ') + '.' : '';
}

// Fire-and-forget: safe to call from anywhere without awaiting or catching.
async function refreshWhoisIfDue(passportId, userId, reason) {
  if (!passportId) return;
  try {
    const [[latest]] = await db.execute(
      'SELECT created_at, narrative_text FROM learner_whois WHERE passport_id = ? ORDER BY id DESC LIMIT 1',
      [passportId]
    );
    if (latest && (Date.now() - new Date(latest.created_at).getTime()) < COOLDOWN_MS) return;

    const passportData = await fetchFullPassport(passportId);
    const coreText = _buildCoreText(passportData);
    const renderedForLLM = renderPassportText(passportData);
    const narrativeText = await llm.generateWhoisNarrative(renderedForLLM, latest?.narrative_text || null, userId);

    await db.execute(
      'INSERT INTO learner_whois (passport_id, core_text, narrative_text, trigger_reason) VALUES (?, ?, ?, ?)',
      [passportId, coreText, narrativeText, (reason || 'unknown').slice(0, 64)]
    );
  } catch (err) {
    console.error('[whois/refreshWhoisIfDue]', err.message);
  }
}

// Formatted for direct injection into any system prompt. Empty string (not
// an error) for a passport with no entry yet — every consumer just gets no
// LEARNER CONTEXT section until the first trigger fires.
async function getWhoisBlock(passportId) {
  if (!passportId) return '';
  try {
    const [[row]] = await db.execute(
      'SELECT core_text, narrative_text FROM learner_whois WHERE passport_id = ? ORDER BY id DESC LIMIT 1',
      [passportId]
    );
    if (!row) return '';
    const parts = [row.core_text, row.narrative_text].filter(Boolean);
    if (!parts.length) return '';
    return `\n\nLEARNER CONTEXT (single source of truth on this learner — supersedes any other partial info you may have):\n${parts.join('\n\n')}`;
  } catch (err) {
    console.error('[whois/getWhoisBlock]', err.message);
    return '';
  }
}

module.exports = { getWhoisBlock, refreshWhoisIfDue };
