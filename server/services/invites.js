const db = require('../db');
const { awardLumens } = require('./game');

// Called right after ANY new account is created — password signup or any
// SSO provider's first-time login — regardless of which of the 4 signup
// methods was used. Deliberately just an email match, not a referral
// token/link: if the invited person signs up with a different email, the
// inviter simply doesn't get this second bonus (they already got the first
// one for sending the invite) — no attempt to track that case.
async function checkFriendJoinBonus(email) {
  if (!email) return;
  try {
    const [rows] = await db.execute(
      "SELECT id, inviter_passport_id FROM friend_invites WHERE invitee_email = ? AND status = 'sent'",
      [email]
    );
    if (!rows.length) return;
    const invite = rows[0];

    // Atomic status flip guards against ever double-awarding this bonus.
    const [result] = await db.execute(
      "UPDATE friend_invites SET status = 'joined', joined_at = NOW() WHERE id = ? AND status = 'sent'",
      [invite.id]
    );
    if (!result.affectedRows) return;

    await awardLumens(invite.inviter_passport_id, null, 10, 'friend_joined', invite.id);
  } catch (err) {
    console.error('[invites/checkFriendJoinBonus]', err.message);
  }
}

module.exports = { checkFriendJoinBonus };
