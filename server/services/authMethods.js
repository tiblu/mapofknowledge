const db = require('../db');

// Total number of independent ways this account can currently sign in —
// password, each linked SSO provider, and each registered passkey all
// count as one. Shared by the SSO-disconnect route (account.js) and the
// passkey-removal route (webauthn.js) so neither one can ever strip away
// the very last method: there's no password-reset flow yet, so losing
// every method would mean permanent lockout with no way back in.
async function countAuthMethods(userId) {
  const [[user]] = await db.execute(
    'SELECT password_hash, google_linked, discord_linked, linkedin_linked FROM users WHERE id = ?',
    [userId]
  );
  const [[{ passkeyCount }]] = await db.execute(
    'SELECT COUNT(*) AS passkeyCount FROM webauthn_credentials WHERE user_id = ?',
    [userId]
  );
  return (user.password_hash ? 1 : 0) + (user.google_linked ? 1 : 0) +
    (user.discord_linked ? 1 : 0) + (user.linkedin_linked ? 1 : 0) + passkeyCount;
}

module.exports = { countAuthMethods };
