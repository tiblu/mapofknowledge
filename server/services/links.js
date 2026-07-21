const db = require('../db');
const { notify, getUserLocale } = require('./notifications');

const MAX_CONNECT_AGE = 20;

function generateCode() {
  return Math.random().toString(36).substring(2, 10).toUpperCase();
}

// Redeems a persistent teacher/parent connection code for a learner account.
// Shared by POST /api/links/redeem and the signup wizard's optional code
// field (server/routes/auth.js) so both paths enforce identical rules.
//
// Returns { ok: true, role, linkedName, alreadyConnected? } or
// { ok: false, error } where error is one of:
//   invalid_code | self | role_not_allowed | birth_year_required | too_old
async function redeemLinkCode({ passportId, userId, userRole, birthYear, code, bypassChecks }) {
  if (!code) return { ok: false, error: 'invalid_code' };
  const normCode = String(code).trim().toUpperCase();

  const [owners] = await db.execute(
    `SELECT u.id, u.link_code_role, lp.display_name
     FROM users u LEFT JOIN learner_passports lp ON lp.id = u.passport_id
     WHERE u.link_code = ?`,
    [normCode]
  );
  if (!owners.length) return { ok: false, error: 'invalid_code' };
  const owner = owners[0];
  if (owner.id === userId) return { ok: false, error: 'self' };
  const role = owner.link_code_role;

  // Already connected (possibly re-entering the same code by accident) —
  // a harmless no-op, no need to re-run eligibility checks against it.
  const [existing] = await db.execute(
    `SELECT id, status FROM learner_links WHERE passport_id = ? AND linked_user_id = ? AND role = ?`,
    [passportId, owner.id, role]
  );
  if (existing.length && existing[0].status === 'active') {
    return { ok: true, alreadyConnected: true, role, linkedName: owner.display_name };
  }

  if (!bypassChecks) {
    if (userRole !== 'learner') return { ok: false, error: 'role_not_allowed' };
    if (!birthYear) return { ok: false, error: 'birth_year_required' };
    const age = new Date().getFullYear() - birthYear;
    if (age > MAX_CONNECT_AGE) return { ok: false, error: 'too_old' };
  }

  if (existing.length) {
    await db.execute(
      `UPDATE learner_links SET status = 'active', accepted_at = NOW() WHERE id = ?`,
      [existing[0].id]
    );
  } else {
    await db.execute(
      `INSERT INTO learner_links (passport_id, linked_user_id, role, status, accepted_at, invited_at)
       VALUES (?, ?, ?, 'active', NOW(), NOW())`,
      [passportId, owner.id, role]
    );
  }

  const ownerLocale = await getUserLocale(owner.id);
  notify(owner.id, 'link_accepted',
    ownerLocale === 'et' ? 'Uus ühendus loodud' : 'New connection made',
    ownerLocale === 'et' ? 'Keegi ühendas oma konto sinuga.' : 'Someone connected their account to you.');

  return { ok: true, role, linkedName: owner.display_name };
}

module.exports = { redeemLinkCode, generateCode, MAX_CONNECT_AGE };
