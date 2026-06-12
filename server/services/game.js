const db = require('../db');

// ── Rank ladder ───────────────────────────────────────────────────────────────
const RANKS = [
  { title: 'Wanderer',     min: 0 },
  { title: 'Scout',        min: 500 },
  { title: 'Surveyor',     min: 1500 },
  { title: 'Cartographer', min: 4000 },
  { title: 'Navigator',    min: 10000 },
  { title: 'Geographer',   min: 25000 },
  { title: 'Polymath',     min: 60000 },
];

function getRank(lumens) {
  let rank = RANKS[0];
  for (const r of RANKS) { if (lumens >= r.min) rank = r; }
  return rank;
}

// ── Achievement definitions ───────────────────────────────────────────────────
// Each def: { name, triggers (optional whitelist), check(passportId, ctx) → bool }
const ACHIEVEMENTS = {

  first_expedition: {
    name: 'First Expedition',
    triggers: ['knobit_complete'],
    check: async (passportId, ctx) => ctx.totalEver === 1,
  },

  perfect_survey: {
    name: 'Perfect Survey',
    triggers: ['test_complete'],
    check: async (passportId, ctx) => ctx.score === 100,
  },

  three_peaks: {
    name: 'Three Peaks',
    triggers: ['test_complete'],
    check: async (passportId, ctx) => {
      const [[{ cnt }]] = await db.execute(
        `SELECT COUNT(DISTINCT k.node_id) AS cnt
         FROM lumen_transactions lt
         JOIN nodes n ON lt.reference_id = n.external_id
         JOIN knobits k ON k.node_id = n.id
         WHERE lt.passport_id = ? AND lt.reason = 'test_perfect'`,
        [passportId]
      );
      return cnt >= 3;
    },
  },

  polymath_path: {
    name: "The Polymath's Path",
    triggers: ['knobit_complete'],
    check: async (passportId) => {
      const [[{ cnt }]] = await db.execute(
        `SELECT COUNT(DISTINCT k.node_id) AS cnt
         FROM knobit_progress kp
         JOIN knobits k ON kp.knobit_id = k.id
         WHERE kp.passport_id = ? AND kp.phase_reached = 'done'`,
        [passportId]
      );
      return cnt >= 50;
    },
  },

  deep_waters: {
    name: 'Deep Waters',
    triggers: ['knobit_complete'],
    check: async (passportId) => {
      // True if any L4 node has all its L5 children fully learned
      const [[{ cnt }]] = await db.execute(
        `SELECT COUNT(*) AS cnt FROM (
           SELECT parent.id,
                  COUNT(child.id)                                                    AS total,
                  COUNT(CASE WHEN unk.percentage >= 80 THEN 1 END)                 AS mastered
           FROM nodes parent
           JOIN nodes child ON child.parent_id = parent.id AND child.level = 5
           LEFT JOIN user_node_knowledge unk
                  ON unk.node_external_id = child.external_id AND unk.passport_id = ?
           WHERE parent.level = 4
           GROUP BY parent.id
           HAVING mastered > 0 AND mastered = total
         ) x`,
        [passportId]
      );
      return cnt >= 1;
    },
  },

  continent_charted: {
    name: 'Continent Charted',
    triggers: ['test_complete'],
    check: async (passportId) => {
      // Any L1 domain where every L5 descendant is mastered (≥80%)
      const [[{ cnt }]] = await db.execute(
        `SELECT COUNT(*) AS cnt FROM (
           SELECT root.id,
                  COUNT(leaf.id)                                                     AS total,
                  COUNT(CASE WHEN unk.percentage >= 80 THEN 1 END)                 AS mastered
           FROM nodes root
           JOIN nodes leaf ON leaf.level = 5
             AND leaf.external_id IN (
               WITH RECURSIVE desc_cte AS (
                 SELECT id, external_id FROM nodes WHERE id = root.id
                 UNION ALL
                 SELECT n.id, n.external_id FROM nodes n JOIN desc_cte d ON n.parent_id = d.id
               ) SELECT external_id FROM desc_cte
             )
           LEFT JOIN user_node_knowledge unk
                  ON unk.node_external_id = leaf.external_id AND unk.passport_id = ?
           WHERE root.level = 1
           GROUP BY root.id
           HAVING mastered > 0 AND mastered = total
         ) x`,
        [passportId]
      );
      return cnt >= 1;
    },
  },

  night_cartographer: {
    name: 'Night Cartographer',
    check: async () => { const h = new Date().getHours(); return h >= 0 && h < 5; },
  },

  dawn_patrol: {
    name: 'Dawn Patrol',
    check: async () => { const h = new Date().getHours(); return h >= 4 && h < 7; },
  },

  the_long_road: {
    name: 'The Long Road',
    check: async (passportId) => {
      const [rows] = await db.execute(
        'SELECT last_activity_at FROM user_momentum WHERE passport_id = ?', [passportId]
      );
      if (!rows.length) return false;
      const daysSince = (Date.now() - new Date(rows[0].last_activity_at).getTime()) / 86400000;
      return daysSince >= 30;
    },
  },

};

// ── Momentum ──────────────────────────────────────────────────────────────────
function _calcMultiplier(streakDays) {
  if (streakDays >= 7)  return 2.00;
  if (streakDays >= 4)  return 1.50;
  if (streakDays >= 2)  return 1.25;
  return 1.00;
}

function momentumLabel(multiplier) {
  if (multiplier >= 2.0)  return 'Full sail';
  if (multiplier >= 1.5)  return 'Steady expedition';
  if (multiplier >= 1.25) return 'Building pace';
  return 'Setting out';
}

async function getMomentum(passportId) {
  const [rows] = await db.execute(
    'SELECT last_activity_at, streak_days, multiplier FROM user_momentum WHERE passport_id = ?',
    [passportId]
  );
  if (!rows.length) return { multiplier: 1.0, streakDays: 0, label: 'Setting out' };

  const m = rows[0];
  const hoursSince = (Date.now() - new Date(m.last_activity_at).getTime()) / 3600000;
  if (hoursSince > 72) {
    await db.execute(
      'UPDATE user_momentum SET streak_days=0, multiplier=1.00, updated_at=NOW() WHERE passport_id=?',
      [passportId]
    );
    return { multiplier: 1.0, streakDays: 0, label: 'Setting out' };
  }
  const mult = parseFloat(m.multiplier);
  return { multiplier: mult, streakDays: m.streak_days, label: momentumLabel(mult) };
}

async function _updateMomentum(passportId) {
  const [rows] = await db.execute(
    'SELECT last_activity_at, streak_days FROM user_momentum WHERE passport_id = ?',
    [passportId]
  );

  if (!rows.length) {
    const mult = _calcMultiplier(1);
    await db.execute(
      'INSERT INTO user_momentum (passport_id, last_activity_at, streak_days, multiplier) VALUES (?, NOW(), 1, ?)',
      [passportId, mult]
    );
    return mult;
  }

  const m = rows[0];
  const hoursSince = (Date.now() - new Date(m.last_activity_at).getTime()) / 3600000;
  const daysSince  = Math.floor(hoursSince / 24);

  let streakDays = m.streak_days;
  if (hoursSince > 72) {
    streakDays = 1;
  } else if (daysSince >= 1) {
    streakDays = Math.min(streakDays + 1, 14);
  }

  const mult = _calcMultiplier(streakDays);
  await db.execute(
    'UPDATE user_momentum SET last_activity_at=NOW(), streak_days=?, multiplier=?, updated_at=NOW() WHERE passport_id=?',
    [streakDays, mult, passportId]
  );
  return mult;
}

// ── Award Lumens ──────────────────────────────────────────────────────────────
async function awardLumens(passportId, userId, baseAmount, reason, referenceId) {
  if (!passportId || baseAmount <= 0) return 0;
  try {
    const multiplier = await _updateMomentum(passportId);
    const amount = Math.round(baseAmount * multiplier);
    await db.execute(
      'INSERT INTO lumen_transactions (passport_id, amount, reason, reference_id, multiplier) VALUES (?, ?, ?, ?, ?)',
      [passportId, amount, reason, referenceId ?? null, multiplier]
    );
    await db.execute(
      'UPDATE learner_passports SET lumen_total = lumen_total + ? WHERE id = ?',
      [amount, passportId]
    );
    return amount;
  } catch (err) {
    console.error('[game/awardLumens]', err.message);
    return 0;
  }
}

// ── Check achievements ────────────────────────────────────────────────────────
async function checkAchievements(passportId, userId, trigger, ctx = {}) {
  if (!passportId) return;
  try {
    const [unlocked] = await db.execute(
      'SELECT achievement_key FROM user_achievements WHERE passport_id = ?', [passportId]
    );
    const have = new Set(unlocked.map(r => r.achievement_key));

    for (const [key, def] of Object.entries(ACHIEVEMENTS)) {
      if (have.has(key)) continue;
      if (def.triggers && !def.triggers.includes(trigger)) continue;
      try {
        if (await def.check(passportId, ctx)) {
          await db.execute(
            'INSERT IGNORE INTO user_achievements (passport_id, achievement_key) VALUES (?, ?)',
            [passportId, key]
          );
          const { notify } = require('./notifications');
          notify(userId, 'achievement',
            `Medal unlocked: ${def.name}`,
            `You've earned the "${def.name}" expedition medal.`
          );
        }
      } catch { /* individual check failure is non-fatal */ }
    }
  } catch (err) {
    console.error('[game/checkAchievements]', err.message);
  }
}

// ── Game state for API ────────────────────────────────────────────────────────
async function getGameState(passportId) {
  if (!passportId) return null;
  try {
    const [[passport]] = await db.execute(
      'SELECT lumen_total FROM learner_passports WHERE id = ?', [passportId]
    );
    const lumens = passport?.lumen_total || 0;
    const rank   = getRank(lumens);
    const next   = RANKS.find(r => r.min > lumens) || null;
    const mom    = await getMomentum(passportId);

    const [achievements] = await db.execute(
      `SELECT achievement_key, unlocked_at
       FROM user_achievements WHERE passport_id = ? ORDER BY unlocked_at DESC`,
      [passportId]
    );
    const [recent] = await db.execute(
      `SELECT reason, amount, multiplier, created_at
       FROM lumen_transactions WHERE passport_id = ? ORDER BY created_at DESC LIMIT 10`,
      [passportId]
    );

    return {
      lumens,
      rank: rank.title,
      rankMin: rank.min,
      nextRank: next ? { title: next.title, min: next.min } : null,
      momentum: { ...mom },
      achievements,
      recentTransactions: recent,
    };
  } catch (err) {
    console.error('[game/getGameState]', err.message);
    return null;
  }
}

// ── All achievement definitions (for listing) ─────────────────────────────────
function getAllAchievements() {
  return Object.entries(ACHIEVEMENTS).map(([key, def]) => ({ key, name: def.name }));
}

module.exports = { awardLumens, checkAchievements, getGameState, getMomentum, getRank, RANKS, getAllAchievements };
