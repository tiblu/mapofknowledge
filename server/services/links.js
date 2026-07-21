const db = require('../db');
const { notify, getUserLocale } = require('./notifications');
const { sendChildInviteEmail } = require('./mailer');

const MAX_CONNECT_AGE = 20;
const MAX_CHILDREN = 5; // quiet soft cap — not advertised anywhere, just enforced

function generateCode() {
  return Math.random().toString(36).substring(2, 10).toUpperCase();
}

async function _activeChildCount(parentUserId) {
  const [[row]] = await db.execute(
    `SELECT COUNT(*) AS n FROM learner_links WHERE linked_user_id = ? AND role = 'parent' AND status = 'active'`,
    [parentUserId]
  );
  return row.n;
}

// Redeems a persistent teacher/parent connection code for a learner account.
// Shared by POST /api/links/redeem and the signup wizard's optional code
// field (server/routes/auth.js) so both paths enforce identical rules.
//
// Returns { ok: true, role, linkedName, alreadyConnected? } or
// { ok: false, error } where error is one of:
//   invalid_code | self | role_not_allowed | birth_year_required | too_old | max_children
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
    if (role === 'parent' && (await _activeChildCount(owner.id)) >= MAX_CHILDREN) {
      return { ok: false, error: 'max_children' };
    }
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

// Child-initiated: a learner invites a parent by email. Unlike the
// teacher/student direction, a child can start this from their own side —
// creates a pending learner_links row (linked_user_id NULL) holding a
// one-time code, and emails it to the address given. The parent redeems it
// themselves via acceptChildInvite(), from their own Seaded.
//
// Returns { ok: true, code } or { ok: false, error } where error is one of:
//   invalid_email | role_not_allowed | birth_year_required | too_old
async function sendChildInvite({ passportId, userRole, birthYear, email, bypassChecks }) {
  const normEmail = String(email || '').trim().toLowerCase();
  if (!normEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normEmail)) {
    return { ok: false, error: 'invalid_email' };
  }
  if (!bypassChecks) {
    if (userRole !== 'learner') return { ok: false, error: 'role_not_allowed' };
    if (!birthYear) return { ok: false, error: 'birth_year_required' };
    const age = new Date().getFullYear() - birthYear;
    if (age > MAX_CONNECT_AGE) return { ok: false, error: 'too_old' };
  }

  const code = generateCode();
  await db.execute(
    `INSERT INTO learner_links (passport_id, linked_user_id, role, status, invite_code, invited_at)
     VALUES (?, NULL, 'parent', 'pending', ?, NOW())`,
    [passportId, code]
  );

  const [[passport]] = await db.execute('SELECT display_name FROM learner_passports WHERE id = ?', [passportId]);
  await sendChildInviteEmail(normEmail, passport?.display_name || null, code, 'et');

  return { ok: true, code };
}

// Parent-initiated acceptance of a child's invite code (the reverse of
// sendChildInvite). Enforces the same 5-child cap as the persistent-code
// path — a child can reach the cap via either direction.
//
// Returns { ok: true, childName } or { ok: false, error } where error is
// one of: invalid_code | self | max_children
async function acceptChildInvite({ parentUserId, parentPassportId, code, bypassChecks }) {
  if (!code) return { ok: false, error: 'invalid_code' };
  const normCode = String(code).trim().toUpperCase();

  const [rows] = await db.execute(
    `SELECT ll.id, ll.passport_id, lp.display_name
     FROM learner_links ll
     JOIN learner_passports lp ON lp.id = ll.passport_id
     WHERE ll.invite_code = ? AND ll.role = 'parent' AND ll.status = 'pending' AND ll.linked_user_id IS NULL`,
    [normCode]
  );
  if (!rows.length) return { ok: false, error: 'invalid_code' };
  const invite = rows[0];
  if (invite.passport_id === parentPassportId) return { ok: false, error: 'self' };

  // Already connected some other way (e.g. the child also redeemed this
  // parent's persistent code) — harmless no-op, code just gets consumed.
  const [existing] = await db.execute(
    `SELECT id, status FROM learner_links WHERE passport_id = ? AND linked_user_id = ? AND role = 'parent'`,
    [invite.passport_id, parentUserId]
  );
  if (existing.length && existing[0].status === 'active') {
    await db.execute(`UPDATE learner_links SET status = 'revoked' WHERE id = ?`, [invite.id]);
    return { ok: true, alreadyConnected: true, childName: invite.display_name };
  }

  if (!bypassChecks && (await _activeChildCount(parentUserId)) >= MAX_CHILDREN) {
    return { ok: false, error: 'max_children' };
  }

  await db.execute(
    `UPDATE learner_links SET linked_user_id = ?, status = 'active', accepted_at = NOW() WHERE id = ?`,
    [parentUserId, invite.id]
  );

  const [childUsers] = await db.execute('SELECT id FROM users WHERE passport_id = ?', [invite.passport_id]);
  if (childUsers.length) {
    const childLocale = await getUserLocale(childUsers[0].id);
    notify(childUsers[0].id, 'link_accepted',
      childLocale === 'et' ? 'Uus ühendus loodud' : 'New connection made',
      childLocale === 'et' ? 'Vanem kinnitas ühenduse.' : 'A parent accepted your connection.');
  }

  return { ok: true, childName: invite.display_name };
}

module.exports = {
  redeemLinkCode, sendChildInvite, acceptChildInvite, generateCode,
  MAX_CONNECT_AGE, MAX_CHILDREN,
};
