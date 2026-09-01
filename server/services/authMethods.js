const db = require('../db');

// Total number of independent ways this account can currently sign in —
// password, each linked SSO provider, and each registered passkey all
// count as one. Used by the passkey-removal route (webauthn.js) so it can
// never strip away the very last method: losing every method would mean
// permanent lockout, unless a password (recoverable via reset-password) is
// also set. Ported from themapofknowledge.com's 2026-09-01 review.
async function countAuthMethods(userId) {
  const [[user]] = await db.execute(
    'SELECT password_hash, google_linked, discord_linked FROM users WHERE id = ?',
    [userId]
  );
  const [[{ passkeyCount }]] = await db.execute(
    'SELECT COUNT(*) AS passkeyCount FROM webauthn_credentials WHERE user_id = ?',
    [userId]
  );
  return (user.password_hash ? 1 : 0) + (user.google_linked ? 1 : 0) +
    (user.discord_linked ? 1 : 0) + passkeyCount;
}

module.exports = { countAuthMethods };
