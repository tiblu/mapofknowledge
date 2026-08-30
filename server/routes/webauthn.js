// ══════════════════════════════════════════════════════════════════════════
// PASSKEYS (WebAuthn) — server/routes/webauthn.js
// ──────────────────────────────────────────────────────────────────────────
// Mounted at /auth/webauthn, unprotected like the rest of auth.js — the
// login/* routes have no session yet by definition, so auth is checked
// per-route (register/list/delete require req.isAuthenticated()).
//
// Add-on only, by design: a passkey is an ADDITIONAL sign-in method for an
// account that already exists via password or Google. There is no
// passkey-only signup — this app has no password-reset flow yet, so a
// brand-new account with no fallback and every passkey device lost would
// have no way back in. Registration therefore always requires an existing
// authenticated session.
//
// Flow (mirrors @simplewebauthn's standard two-step "options then verify"
// pattern for both registration and authentication):
//   POST /register/options  (auth) — returns a WebAuthn creation challenge;
//                                     challenge is stashed in req.session.
//   POST /register/verify   (auth) — client's attestation is verified
//                                     against that challenge and stored.
//   POST /login/options            — returns an assertion challenge with NO
//                                     allowCredentials list, so the browser
//                                     prompts with any resident credential
//                                     for this site ("usernameless" login —
//                                     no email typed first).
//   POST /login/verify             — the credential id in the response tells
//                                     us which user it belongs to; verified
//                                     against the stored public key, then
//                                     req.login() establishes the session
//                                     exactly like password login does.
// ══════════════════════════════════════════════════════════════════════════
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { loginRateLimit } = require('../middleware/authRateLimit');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const RP_NAME = 'Map of Knowledge';
const RP_ID   = new URL(process.env.BASE_URL || 'https://themapofknowledge.com').hostname;
const ORIGIN  = process.env.BASE_URL || 'https://themapofknowledge.com';

const MAX_NICKNAME_LEN = 60;

function _requireAuth(req, res) {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: 'not_authenticated' });
    return false;
  }
  return true;
}

// ── Registration — add a passkey to the signed-in account ───────────────────
router.post('/register/options', async (req, res) => {
  if (!_requireAuth(req, res)) return;
  try {
    const [existing] = await db.execute(
      'SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?',
      [req.user.id]
    );
    const excludeCredentials = existing.map(c => ({
      id: c.credential_id,
      transports: c.transports ? c.transports.split(',') : undefined,
    }));

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userName: req.user.email,
      userID: Buffer.from(String(req.user.id), 'utf8'),
      userDisplayName: req.user.email,
      attestationType: 'none',
      excludeCredentials,
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });

    req.session.webauthnChallenge = options.challenge;
    res.json(options);
  } catch (err) {
    console.error('[webauthn/register/options]', err.message);
    res.status(500).json({ error: 'options_failed' });
  }
});

router.post('/register/verify', async (req, res) => {
  if (!_requireAuth(req, res)) return;
  const expectedChallenge = req.session.webauthnChallenge;
  if (!expectedChallenge) return res.status(400).json({ error: 'no_challenge' });

  const nickname = typeof req.body.nickname === 'string'
    ? req.body.nickname.trim().slice(0, MAX_NICKNAME_LEN) || null
    : null;

  try {
    const verification = await verifyRegistrationResponse({
      response: req.body.response,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });
    req.session.webauthnChallenge = null;

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'verification_failed' });
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    await db.execute(
      `INSERT INTO webauthn_credentials
         (user_id, credential_id, public_key, counter, device_type, backed_up, transports, nickname)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        credential.id,
        Buffer.from(credential.publicKey).toString('base64url'),
        credential.counter,
        credentialDeviceType,
        credentialBackedUp ? 1 : 0,
        (credential.transports || []).join(','),
        nickname,
      ]
    );
    res.json({ ok: true });
  } catch (err) {
    req.session.webauthnChallenge = null;
    console.error('[webauthn/register/verify]', err.message);
    res.status(400).json({ error: 'verification_failed' });
  }
});

// ── List / remove registered passkeys ────────────────────────────────────────
router.get('/credentials', async (req, res) => {
  if (!_requireAuth(req, res)) return;
  try {
    const [rows] = await db.execute(
      `SELECT id, nickname, device_type, created_at, last_used_at
       FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'list_failed' });
  }
});

router.delete('/credentials/:id', async (req, res) => {
  if (!_requireAuth(req, res)) return;
  try {
    await db.execute(
      'DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'delete_failed' });
  }
});

// ── Login — usernameless: no allowCredentials, the authenticator/browser
//    picks from whichever resident credential(s) it holds for this RP ──────
router.post('/login/options', loginRateLimit, async (req, res) => {
  try {
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: 'preferred',
    });
    req.session.webauthnChallenge = options.challenge;
    res.json(options);
  } catch (err) {
    console.error('[webauthn/login/options]', err.message);
    res.status(500).json({ error: 'options_failed' });
  }
});

router.post('/login/verify', loginRateLimit, async (req, res) => {
  const expectedChallenge = req.session.webauthnChallenge;
  if (!expectedChallenge) return res.status(400).json({ error: 'no_challenge' });

  const response = req.body.response;
  const credentialId = response && response.id;
  if (typeof credentialId !== 'string') return res.status(400).json({ error: 'invalid_response' });

  try {
    const [rows] = await db.execute(
      'SELECT * FROM webauthn_credentials WHERE credential_id = ?',
      [credentialId]
    );
    if (!rows.length) {
      req.session.webauthnChallenge = null;
      return res.status(401).json({ error: 'unknown_credential' });
    }
    const stored = rows[0];

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: stored.credential_id,
        publicKey: Buffer.from(stored.public_key, 'base64url'),
        counter: Number(stored.counter),
        transports: stored.transports ? stored.transports.split(',') : undefined,
      },
    });
    req.session.webauthnChallenge = null;

    if (!verification.verified) {
      return res.status(401).json({ error: 'verification_failed' });
    }

    await db.execute(
      'UPDATE webauthn_credentials SET counter = ?, last_used_at = NOW() WHERE id = ?',
      [verification.authenticationInfo.newCounter, stored.id]
    );

    const [users] = await db.execute('SELECT * FROM users WHERE id = ?', [stored.user_id]);
    if (!users.length) return res.status(401).json({ error: 'unknown_credential' });
    const user = users[0];

    const isFirstLogin = !user.last_login;
    await db.execute('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);
    if (isFirstLogin) {
      const { notify } = require('../services/notifications');
      notify(user.id, 'welcome', 'Welcome to the Map of Knowledge!',
        'We\'re glad you\'re here. Start exploring the map and begin your journey of discovery. Happy learning!');
    }

    req.login(user, (err) => {
      if (err) return res.status(500).json({ error: 'login_failed' });
      res.json({ ok: true, redirect: '/app/' });
    });
  } catch (err) {
    req.session.webauthnChallenge = null;
    console.error('[webauthn/login/verify]', err.message);
    res.status(401).json({ error: 'verification_failed' });
  }
});

module.exports = router;
