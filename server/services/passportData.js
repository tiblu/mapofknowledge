// Full Learner Passport data fetch — extracted from server/routes/api.js's
// former _fetchFullPassport so server/services/whois.js can reuse the exact
// same shape without duplicating a dozen queries (same reasoning as
// nodeKnowledge.js's extraction for knowledgeEstimate.js).
const db = require('../db');

async function fetchFullPassport(passportId) {
  const [[passport]] = await db.execute(
    'SELECT * FROM learner_passports WHERE id = ?', [passportId]
  );

  // avatar_url lives on users (it's an auth-provider attribute, not a
  // passport one), joined back in here since every consumer of this
  // function renders identity from the passport object.
  const [[avatarRow]] = await db.execute(
    'SELECT avatar_url FROM users WHERE passport_id = ?', [passportId]
  );
  if (passport) passport.avatar_url = avatarRow ? avatarRow.avatar_url : null;

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
    // Topmost ancestor (L1 domain) — used to group the Knowledge card "By domain".
    domain:     r.p4 || r.p3 || r.p2 || r.p1 || r.label,
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

module.exports = { fetchFullPassport };
