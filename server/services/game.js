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

  boundless_atlas: {
    // Next tier beyond polymath_path — same shape, 3x the bar.
    name: 'The Boundless Atlas',
    triggers: ['knobit_complete'],
    check: async (passportId) => {
      const [[{ cnt }]] = await db.execute(
        `SELECT COUNT(DISTINCT k.node_id) AS cnt
         FROM knobit_progress kp
         JOIN knobits k ON kp.knobit_id = k.id
         WHERE kp.passport_id = ? AND kp.phase_reached = 'done'`,
        [passportId]
      );
      return cnt >= 150;
    },
  },

  deep_waters: {
    name: 'Deep Waters',
    triggers: ['knobit_complete'],
    check: async (passportId) => {
      // True if any L4 node has all its L5 children fully COMPLETED (100%,
      // not just mastered) — every knobit in every child node is done.
      const [[{ cnt }]] = await db.execute(
        `SELECT COUNT(*) AS cnt FROM (
           SELECT parent.id,
                  COUNT(child.id)                                          AS total,
                  COUNT(CASE WHEN unk.percentage = 100 THEN 1 END)         AS completed
           FROM nodes parent
           JOIN nodes child ON child.parent_id = parent.id AND child.level = 5
           LEFT JOIN user_node_knowledge unk
                  ON unk.node_external_id = child.external_id AND unk.passport_id = ?
           WHERE parent.level = 4
           GROUP BY parent.id
           HAVING completed > 0 AND completed = total
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
      // Any L1 domain where every L5 descendant is fully COMPLETED (100%,
      // not just an 80% mastery threshold).
      const [[{ cnt }]] = await db.execute(
        `SELECT COUNT(*) AS cnt FROM (
           SELECT root.id,
                  COUNT(leaf.id)                                           AS total,
                  COUNT(CASE WHEN unk.percentage = 100 THEN 1 END)         AS completed
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
           HAVING completed > 0 AND completed = total
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

  first_reflection: {
    name: 'Explorer Diary Started',
    triggers: ['reflection'],
    check: async (passportId) => {
      const [[{ cnt }]] = await db.execute(
        'SELECT COUNT(*) AS cnt FROM passport_reflections WHERE passport_id = ?', [passportId]
      );
      return cnt === 1;
    },
  },

  first_anne_chat: {
    name: 'Fireside Chat',
    triggers: ['anne_chat'],
    check: async (passportId) => {
      const [[{ cnt }]] = await db.execute(
        `SELECT COUNT(*) AS cnt FROM anne_messages WHERE passport_id = ? AND role = 'user'`, [passportId]
      );
      return cnt === 1;
    },
  },

  first_goal_added: {
    name: 'Marks the Spot',
    triggers: ['goal_added'],
    check: async (passportId) => {
      const [[{ cnt }]] = await db.execute(
        'SELECT COUNT(*) AS cnt FROM passport_goals WHERE passport_id = ?', [passportId]
      );
      return cnt === 1;
    },
  },

  first_goal_complete: {
    name: 'First Peak Reached',
    triggers: ['goal_complete'],
    check: async (passportId) => {
      const [[{ cnt }]] = await db.execute(
        `SELECT COUNT(*) AS cnt FROM passport_goals WHERE passport_id = ? AND status = 'completed'`, [passportId]
      );
      return cnt === 1;
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

// ── Streaks ──────────────────────────────────────────────────────────────────
// Deliberately independent of lumens/momentum above — a streak is "did you
// complete a knobit today", full stop. today/last_completion_date are always
// the LEARNER'S LOCAL calendar date ('YYYY-MM-DD'), sent by the client (see
// _localDateStr in learning.js/profile.js) — there is no stored timezone
// anywhere in this app, so the client is the only thing that actually knows
// what day it is for that person. Never compare this against server UTC dates.
const MAX_STREAK_SAVERS = 3;

function _isValidYMD(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// Fallback only for callers that somehow have no client date at all — an
// approximation (server/UTC "today"), not the source of truth.
function _fallbackToday() {
  return new Date().toISOString().slice(0, 10);
}

function _daysBetween(fromYMD, toYMD) {
  const a = new Date(fromYMD + 'T00:00:00Z');
  const b = new Date(toYMD   + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

async function _loadStreakRow(passportId) {
  const [rows] = await db.execute(
    `SELECT current_streak, longest_streak, streak_savers,
            DATE_FORMAT(last_completion_date, '%Y-%m-%d') AS last_completion_date
     FROM user_streaks WHERE passport_id = ?`,
    [passportId]
  );
  return rows[0] || { current_streak: 0, longest_streak: 0, streak_savers: 0, last_completion_date: null };
}

async function _saveStreakRow(passportId, row) {
  await db.execute(
    `INSERT INTO user_streaks (passport_id, current_streak, longest_streak, streak_savers, last_completion_date)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       current_streak = VALUES(current_streak), longest_streak = VALUES(longest_streak),
       streak_savers = VALUES(streak_savers), last_completion_date = VALUES(last_completion_date)`,
    [passportId, row.current_streak, row.longest_streak, row.streak_savers, row.last_completion_date]
  );
}

// Walks forward day-by-day from last_completion_date to today, consuming one
// Streak Saver per fully-missed day. Breaks the streak (resets to 0) the
// first time a missed day has no saver left to cover it. A no-op if there's
// no gap yet (today or yesterday's completion still keeps the streak alive
// without needing a save).
function _catchUp(row, today) {
  if (!row.last_completion_date) return row;
  const gap = _daysBetween(row.last_completion_date, today);
  if (gap <= 1) return row;
  let missedDays = gap - 1;
  let streak = row.current_streak;
  let savers = row.streak_savers;
  while (missedDays > 0) {
    if (savers > 0) { savers -= 1; missedDays -= 1; }
    else { streak = 0; break; }
  }
  return { ...row, current_streak: streak, streak_savers: savers };
}

// Read-time evaluation — used to display current state, including catching
// up (and persisting) a break the learner hasn't triggered by acting yet.
async function getStreak(passportId, todayYMD) {
  if (!passportId) return { currentStreak: 0, longestStreak: 0, streakSavers: 0 };
  const today = _isValidYMD(todayYMD) ? todayYMD : _fallbackToday();
  try {
    const before = await _loadStreakRow(passportId);
    const after  = _catchUp(before, today);
    if (after.current_streak !== before.current_streak || after.streak_savers !== before.streak_savers) {
      await _saveStreakRow(passportId, after);
    }
    return { currentStreak: after.current_streak, longestStreak: after.longest_streak, streakSavers: after.streak_savers };
  } catch (err) {
    console.error('[game/getStreak]', err.message);
    return { currentStreak: 0, longestStreak: 0, streakSavers: 0 };
  }
}

// Called once per knobit completion. A second completion on the same local
// day is a no-op (already counted) beyond running the same catch-up.
async function recordKnobitCompletion(passportId, todayYMD) {
  if (!passportId) return;
  const today = _isValidYMD(todayYMD) ? todayYMD : _fallbackToday();
  try {
    const row = _catchUp(await _loadStreakRow(passportId), today);
    if (row.last_completion_date !== today) {
      row.current_streak += 1;
      row.last_completion_date = today;
      if (row.current_streak > row.longest_streak) row.longest_streak = row.current_streak;
    }
    await _saveStreakRow(passportId, row);
    return { currentStreak: row.current_streak, longestStreak: row.longest_streak, streakSavers: row.streak_savers };
  } catch (err) {
    console.error('[game/recordKnobitCompletion]', err.message);
  }
}

// Called when a node's final knobit completes. Awards a Streak Saver (cap
// MAX_STREAK_SAVERS) if every knobit in the node has a started_at (only true
// for knobits started after this feature shipped — older ones are silently
// skipped, never crash) and the elapsed time from the first knobit's start
// to the last knobit's completion is under 24 hours. Elapsed duration is
// timezone-invariant, unlike a "same calendar day" check would be — this app
// has no stored learner timezone, so duration is the only version of "same
// day" we can actually evaluate correctly server-side.
async function maybeAwardStreakSaver(passportId, nodeDbId, userId) {
  if (!passportId || !nodeDbId) return;
  try {
    const [[row]] = await db.execute(
      `SELECT COUNT(*) AS total,
              SUM(started_at IS NULL) AS missingStart,
              MIN(started_at) AS firstStart,
              MAX(kp.completed_at) AS lastDone
       FROM knobits k
       JOIN knobit_progress kp ON kp.knobit_id = k.id AND kp.passport_id = ?
       WHERE k.node_id = ? AND kp.phase_reached = 'done'`,
      [passportId, nodeDbId]
    );
    if (!row || !row.total || row.missingStart > 0 || !row.firstStart || !row.lastDone) return;
    const elapsedHours = (new Date(row.lastDone) - new Date(row.firstStart)) / 3600000;
    if (elapsedHours >= 24) return;

    const streakRow = await _loadStreakRow(passportId);
    if (streakRow.streak_savers >= MAX_STREAK_SAVERS) return;
    streakRow.streak_savers += 1;
    await _saveStreakRow(passportId, streakRow);

    if (userId) {
      const { notify } = require('./notifications');
      notify(userId, 'achievement', 'Streak Saver earned!',
        'You finished an entire topic in one sitting — a Streak Saver has been added to your account.');
    }
  } catch (err) {
    console.error('[game/maybeAwardStreakSaver]', err.message);
  }
}

// ── Profile-complete bonus (+10, one-time) ────────────────────────────────────
// Identity (name, birth year, location, cultural background), learning needs
// (about), and at least one interest + one value tag — checked after any edit
// to identity or tags. profile_bonus_awarded guards against re-awarding on
// later edits once it's already been given.
async function maybeAwardProfileCompleteBonus(passportId, userId) {
  if (!passportId) return;
  try {
    const [[passport]] = await db.execute(
      `SELECT display_name, birth_year, location, cultural_background, about, profile_bonus_awarded
       FROM learner_passports WHERE id = ?`,
      [passportId]
    );
    if (!passport || passport.profile_bonus_awarded) return;
    const identityDone = !!(passport.display_name && passport.birth_year && passport.location
      && passport.cultural_background && passport.about);
    if (!identityDone) return;

    const [[{ interestCnt }]] = await db.execute(
      `SELECT COUNT(*) AS interestCnt FROM passport_tags WHERE passport_id = ? AND type = 'interest'`,
      [passportId]
    );
    const [[{ valueCnt }]] = await db.execute(
      `SELECT COUNT(*) AS valueCnt FROM passport_tags WHERE passport_id = ? AND type = 'value'`,
      [passportId]
    );
    if (!(interestCnt > 0 && valueCnt > 0)) return;

    await db.execute('UPDATE learner_passports SET profile_bonus_awarded = 1 WHERE id = ?', [passportId]);
    const amount = await awardLumens(passportId, userId, 10, 'profile_complete', null);
    if (userId && amount) {
      const { notify } = require('./notifications');
      notify(userId, 'achievement', `+${amount} lumens!`,
        'Your Learner Passport profile is complete.');
    }
  } catch (err) {
    console.error('[game/maybeAwardProfileCompleteBonus]', err.message);
  }
}

// ── Branch-complete bonus (+100, one-time per branch) ─────────────────────────
// Fires when the just-finished L5 node is the LAST one under its L4 parent to
// reach 100% — i.e. the whole branch is now fully learned. Single level only
// (does not cascade further up to L3/L2/L1). Idempotency reuses the
// user_achievements unique constraint (INSERT IGNORE — if the row already
// existed, affectedRows is 0 and nothing is awarded twice), even though this
// isn't shown as a medal.
async function maybeAwardBranchBonus(passportId, userId, nodeDbId) {
  if (!passportId || !nodeDbId) return;
  try {
    const [[parent]] = await db.execute(
      `SELECT p.id AS parentDbId, p.external_id AS parentExtId, p.label AS parentLabel
       FROM nodes n JOIN nodes p ON n.parent_id = p.id
       WHERE n.id = ? AND p.level = 4`,
      [nodeDbId]
    );
    if (!parent) return;

    const [[{ total, mastered }]] = await db.execute(
      `SELECT COUNT(child.id) AS total,
              COUNT(CASE WHEN unk.percentage = 100 THEN 1 END) AS mastered
       FROM nodes child
       LEFT JOIN user_node_knowledge unk
              ON unk.node_external_id = child.external_id AND unk.passport_id = ?
       WHERE child.parent_id = ? AND child.level = 5`,
      [passportId, parent.parentDbId]
    );
    if (!(total > 0 && mastered === total)) return;

    const [result] = await db.execute(
      'INSERT IGNORE INTO user_achievements (passport_id, achievement_key) VALUES (?, ?)',
      [passportId, 'branch_complete_' + parent.parentExtId]
    );
    if (!result.affectedRows) return;

    const amount = await awardLumens(passportId, userId, 100, 'branch_complete', parent.parentExtId);
    if (userId && amount) {
      const { notify } = require('./notifications');
      notify(userId, 'achievement', `+${amount} lumens!`,
        `You completed every topic under "${parent.parentLabel}".`, parent.parentExtId);
    }
  } catch (err) {
    console.error('[game/maybeAwardBranchBonus]', err.message);
  }
}

module.exports = {
  awardLumens, checkAchievements, getGameState, getMomentum, getRank, RANKS, getAllAchievements,
  getStreak, recordKnobitCompletion, maybeAwardStreakSaver,
  maybeAwardProfileCompleteBonus, maybeAwardBranchBonus,
};
