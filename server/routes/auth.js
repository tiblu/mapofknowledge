const express  = require('express');
const passport = require('passport');
const bcrypt   = require('bcryptjs'); // pure-JS — no native compile step, safer on shared hosting
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { Strategy: DiscordStrategy } = require('passport-discord');
const { Strategy: OpenIDConnectStrategy } = require('passport-openidconnect');
const { randomUUID, randomBytes } = require('crypto');
const db       = require('../db');
const { notify } = require('../services/notifications');
const { moderateTags } = require('../services/llm');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../services/mailer');
const { checkFriendJoinBonus } = require('../services/invites');
const { loginRateLimit, signupRateLimit, resendVerifyRateLimit, resetPasswordRateLimit } = require('../middleware/authRateLimit');
const router   = express.Router();

// ── Cloudflare Turnstile ─────────────────────────────────────────────────────
// Verifies the widget token on signup/login. TURNSTILE_SECRET_KEY isn't set
// yet as of this commit — until it is, this fails OPEN (logs a warning,
// lets the request through) so deploying this code can't itself lock
// anyone out of signing up or logging in. Once the key is added to .env,
// a missing/invalid token starts failing closed as intended. A genuine
// network error reaching Cloudflare also fails open — an outage on their
// side shouldn't take down login for this app.
async function _verifyTurnstile(token, remoteip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    console.warn('[turnstile] TURNSTILE_SECRET_KEY not set — skipping verification');
    return true;
  }
  if (typeof token !== 'string' || !token) return false;

  try {
    const params = new URLSearchParams({ secret, response: token });
    if (remoteip) params.set('remoteip', remoteip);
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const data = await r.json();
    return !!data.success;
  } catch (err) {
    console.error('[turnstile] verify request failed, failing open:', err.message);
    return true;
  }
}

// Mirrors getUserLocale in server/routes/api.js — not imported from there
// since api.js only exports the router itself, not this helper.
async function _getUserLocale(userId) {
  if (!userId) return 'en';
  try {
    const [rows] = await db.execute(
      'SELECT value FROM user_settings WHERE user_id = ? AND key_name = ?',
      [userId, 'ui_locale']
    );
    return (rows.length && rows[0].value) ? rows[0].value : 'en';
  } catch { return 'en'; }
}

// Accounts that get elevated roles on first login.
const ROLE_MAP = {
  'margo.loor@gmail.com':      'super_admin',
  'hannes.tamjarv@meta.ee':    'learner',
};

// ── Shared signup helpers ───────────────────────────────────────────────────
// Validates + moderates the wizard payload (name, birth year, interests,
// values). Used by both the Google-deferred prepare step and the direct
// email+password signup — the DB write only differs in how the `users` row
// itself gets created (password_hash vs OAuth-only).
async function buildPendingSignup(body) {
  const { birthYear, displayName, interests, values } = body;

  const cleanList = (arr) => Array.isArray(arr)
    ? arr.map(s => typeof s === 'string' ? s.trim().slice(0, 60) : '').filter(s => s.length >= 2).slice(0, 10)
    : [];
  const validInterests = cleanList(interests);
  const validValues    = cleanList(values);

  if (validInterests.length < 2 || !validValues.length) {
    return { ok: false, status: 400, body: { error: 'At least two interests and one value are required' } };
  }

  const moderation = await moderateTags(validInterests, validValues);
  if (!moderation.ok) {
    return { ok: false, status: 400, body: { error: 'flagged_content', flagged: moderation.flagged } };
  }

  const yearNum = Number(birthYear);
  const currentYear = new Date().getFullYear();

  return {
    ok: true,
    pending: {
      birthYear:   Number.isInteger(yearNum) && yearNum > 1900 && yearNum <= currentYear ? yearNum : null,
      displayName: typeof displayName === 'string' && displayName.trim() ? displayName.trim().slice(0, 255) : null,
      // Core interests / values -> passport_tags.
      interests: validInterests,
      values:    validValues,
    },
  };
}

async function createPassportFromPending(conn, pending) {
  const [pr] = await conn.execute(
    'INSERT INTO learner_passports (public_id, birth_year, display_name) VALUES (?, ?, ?)',
    [randomUUID(), pending.birthYear || null, pending.displayName || null]
  );
  const passportId = pr.insertId;

  for (let i = 0; i < pending.interests.length; i++) {
    await conn.execute(
      'INSERT INTO passport_tags (passport_id, type, text, sort_order) VALUES (?, "interest", ?, ?)',
      [passportId, pending.interests[i], i]
    );
  }
  for (let i = 0; i < pending.values.length; i++) {
    await conn.execute(
      'INSERT INTO passport_tags (passport_id, type, text, sort_order) VALUES (?, "value", ?, ?)',
      [passportId, pending.values[i], i]
    );
  }

  return passportId;
}

function sendWelcomeNotification(userId) {
  notify(userId, 'welcome', 'Welcome to the Map of Knowledge!',
    'We\'re glad you\'re here. Start exploring the map and begin your journey of discovery. Happy learning!');
}

// ── Shared OAuth find-or-create — same logic for every SSO provider, since
//    all of them are add-on-only: an SSO login only creates a NEW account
//    when a signup flow (buildPendingSignup) was prepared for this session
//    first. Otherwise it's just "log the existing account in", matched by
//    email regardless of which provider it originally signed up with —
//    e.g. a user can sign up via Google and later log in via Discord as
//    long as both report the same email address. ─────────────────────────
// provider -> the users column tracking whether this account has ever
// signed in via that provider (see users.google_linked/discord_linked/
// linkedin_linked, added in migrate.js). Purely for the Account page's
// "Sign-in method" badges — never used for auth decisions.
const PROVIDER_LINKED_COLUMN = {
  google:   'google_linked',
  discord:  'discord_linked',
  linkedin: 'linkedin_linked',
};

async function handleOAuthLogin(req, email, provider, done) {
  if (!email) return done(null, false, { message: 'no_email' });
  const linkedColumn = PROVIDER_LINKED_COLUMN[provider];

  const conn = await db.getConnection();
  try {
    const [users] = await conn.execute('SELECT * FROM users WHERE email = ?', [email]);

    if (users.length === 0) {
      // No existing account — only allow if a signup flow was prepared
      const pending = req.session && req.session.pendingSignup;
      if (!pending) return done(null, false);

      const passportId = await createPassportFromPending(conn, pending);

      const [ur] = await conn.execute(
        `INSERT INTO users (email, role, email_verified, subscription_status, passport_id, last_login, created_at, ${linkedColumn})
         VALUES (?, ?, 1, 'free', ?, NOW(), NOW(), 1)`,
        [email, ROLE_MAP[email] || 'learner', passportId]
      );
      const userId = ur.insertId;

      req.session.pendingSignup = null;
      sendWelcomeNotification(userId);
      checkFriendJoinBonus(email).catch(() => {});

      const [newUsers] = await conn.execute('SELECT * FROM users WHERE id = ?', [userId]);
      return done(null, newUsers[0]);
    }

    // Existing user — normal login
    const user = users[0];
    const isFirstLogin = !user.last_login;
    await conn.execute(
      `UPDATE users SET last_login = NOW(), ${linkedColumn} = 1 WHERE id = ?`,
      [user.id]
    );
    if (isFirstLogin) sendWelcomeNotification(user.id);
    done(null, user);
  } finally {
    conn.release();
  }
}

// ── Passport setup ────────────────────────────────────────────────────────────
passport.use(new GoogleStrategy(
  {
    clientID:          process.env.GOOGLE_CLIENT_ID,
    clientSecret:      process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:       process.env.BASE_URL + '/auth/google/callback',
    passReqToCallback: true,
  },
  async (req, accessToken, refreshToken, profile, done) => {
    try {
      await handleOAuthLogin(req, profile.emails?.[0]?.value?.toLowerCase(), 'google', done);
    } catch (err) {
      done(err);
    }
  }
));

// Discord and LinkedIn are optional — only registered once their app
// credentials exist in .env, so a fresh checkout or a deploy before those
// credentials are configured can't crash the whole server (passport-oauth2-
// based strategies throw synchronously in their constructor if clientID/
// clientSecret are missing). The /discord and /linkedin routes below carry
// the same guard so an unconfigured button fails as a clean redirect
// instead of an "unknown strategy" error.
const discordConfigured  = !!(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET);
const linkedinConfigured = !!(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET);

if (discordConfigured) {
  passport.use(new DiscordStrategy(
    {
      clientID:          process.env.DISCORD_CLIENT_ID,
      clientSecret:      process.env.DISCORD_CLIENT_SECRET,
      callbackURL:       process.env.BASE_URL + '/auth/discord/callback',
      passReqToCallback: true,
    },
    async (req, accessToken, refreshToken, profile, done) => {
      try {
        // Discord's `verified` flag means the user has confirmed this
        // address with Discord — an unverified email isn't a safe identity
        // to match an account against.
        const email = (profile.verified && profile.email) ? profile.email.toLowerCase() : null;
        await handleOAuthLogin(req, email, 'discord', done);
      } catch (err) {
        done(err);
      }
    }
  ));
}

if (linkedinConfigured) {
  passport.use('linkedin', new OpenIDConnectStrategy(
    {
      issuer:            'https://www.linkedin.com/oauth',
      authorizationURL:  'https://www.linkedin.com/oauth/v2/authorization',
      tokenURL:          'https://www.linkedin.com/oauth/v2/accessToken',
      userInfoURL:       'https://api.linkedin.com/v2/userinfo',
      clientID:          process.env.LINKEDIN_CLIENT_ID,
      clientSecret:      process.env.LINKEDIN_CLIENT_SECRET,
      callbackURL:       process.env.BASE_URL + '/auth/linkedin/callback',
      scope:             ['profile', 'email'], // 'openid' is prefixed automatically
      passReqToCallback: true,
    },
    async (req, issuer, profile, done) => {
      try {
        await handleOAuthLogin(req, profile.emails?.[0]?.value?.toLowerCase(), 'linkedin', done);
      } catch (err) {
        done(err);
      }
    }
  ));
}

passport.serializeUser((user, done) => done(null, user.id));

passport.deserializeUser(async (id, done) => {
  try {
    const [rows] = await db.execute('SELECT * FROM users WHERE id = ?', [id]);
    done(null, rows[0] || false);
  } catch (err) {
    done(err);
  }
});

// ── Routes — Google ──────────────────────────────────────────────────────────
router.get('/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: '/?auth=failed' }),
  (req, res) => res.redirect('/app/')
);

// ── Routes — Discord ─────────────────────────────────────────────────────────
router.get('/discord', (req, res, next) => {
  if (!discordConfigured) return res.redirect('/?auth=unavailable');
  passport.authenticate('discord', { scope: ['identify', 'email'] })(req, res, next);
});

router.get('/discord/callback',
  (req, res, next) => discordConfigured ? next() : res.redirect('/?auth=unavailable'),
  passport.authenticate('discord', { failureRedirect: '/?auth=failed' }),
  (req, res) => res.redirect('/app/')
);

// ── Routes — LinkedIn ────────────────────────────────────────────────────────
router.get('/linkedin', (req, res, next) => {
  if (!linkedinConfigured) return res.redirect('/?auth=unavailable');
  passport.authenticate('linkedin')(req, res, next);
});

router.get('/linkedin/callback',
  (req, res, next) => linkedinConfigured ? next() : res.redirect('/?auth=unavailable'),
  passport.authenticate('linkedin', { failureRedirect: '/?auth=failed' }),
  (req, res) => res.redirect('/app/')
);

// Lets the login page show only the SSO buttons that actually work —
// buttons for a provider with no app credentials in .env stay hidden
// rather than leading somewhere that just bounces back with an error.
router.get('/sso-providers', (req, res) => {
  res.json({ discord: discordConfigured, linkedin: linkedinConfigured });
});

router.get('/logout', (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    res.redirect('/');
  });
});

router.get('/me', (req, res) => {
  if (!req.isAuthenticated()) return res.json(null);
  const { id, email, role, passport_id, subscription_status, password_hash, email_verified } = req.user;
  res.json({
    id, email, role, passport_id, subscription_status,
    hasPassword:   !!password_hash,
    emailVerified: !!email_verified,
  });
});

// ── Signup prepare — stores intent in session before Google OAuth ─────────────
router.post('/signup/prepare', signupRateLimit, async (req, res) => {
  if (!(await _verifyTurnstile(req.body.turnstileToken, req.ip))) {
    return res.status(400).json({ error: 'captcha_failed' });
  }
  const built = await buildPendingSignup(req.body);
  if (!built.ok) return res.status(built.status).json(built.body);
  req.session.pendingSignup = built.pending;
  res.json({ ok: true });
});

// ── Signup with email + password — creates the account immediately ───────────
router.post('/signup/password', signupRateLimit, async (req, res) => {
  if (!(await _verifyTurnstile(req.body.turnstileToken, req.ip))) {
    return res.status(400).json({ error: 'captcha_failed' });
  }
  const { email, password } = req.body;
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return res.status(400).json({ error: 'invalid_email' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'weak_password' });
  }
  const normEmail = email.trim().toLowerCase();

  const built = await buildPendingSignup(req.body);
  if (!built.ok) return res.status(built.status).json(built.body);
  const pending = built.pending;

  const conn = await db.getConnection();
  try {
    const [existing] = await conn.execute('SELECT id FROM users WHERE email = ?', [normEmail]);
    if (existing.length) {
      return res.status(409).json({ error: 'email_taken' });
    }

    const passportId   = await createPassportFromPending(conn, pending);
    const passwordHash = await bcrypt.hash(password, 12);
    const verifyToken  = randomBytes(32).toString('hex');

    const [ur] = await conn.execute(
      `INSERT INTO users (email, password_hash, email_verified, email_verify_token, email_verify_expires,
                           role, subscription_status, passport_id, last_login, created_at)
       VALUES (?, ?, 0, ?, DATE_ADD(NOW(), INTERVAL 24 HOUR), ?, 'free', ?, NOW(), NOW())`,
      [normEmail, passwordHash, verifyToken, ROLE_MAP[normEmail] || 'learner', passportId]
    );
    const userId = ur.insertId;

    sendWelcomeNotification(userId);
    sendVerificationEmail(normEmail, verifyToken, 'en')
      .catch(err => console.error('[auth/signup/password] verification email failed:', err.message));
    checkFriendJoinBonus(normEmail).catch(() => {});

    const [newUsers] = await conn.execute('SELECT * FROM users WHERE id = ?', [userId]);
    req.login(newUsers[0], (err) => {
      if (err) return res.status(500).json({ error: 'login_failed' });
      res.json({ ok: true, redirect: '/app/' });
    });
  } catch (err) {
    console.error('[auth/signup/password]', err.message);
    res.status(500).json({ error: 'signup_failed' });
  } finally {
    conn.release();
  }
});

// ── Login with email + password ───────────────────────────────────────────────
router.post('/login', loginRateLimit, async (req, res) => {
  if (!(await _verifyTurnstile(req.body.turnstileToken, req.ip))) {
    return res.status(400).json({ error: 'captcha_failed' });
  }
  const { email, password } = req.body;
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'invalid_credentials' });
  }
  try {
    const [rows] = await db.execute('SELECT * FROM users WHERE email = ?', [email.trim().toLowerCase()]);
    const user = rows[0];
    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    const isFirstLogin = !user.last_login;
    await db.execute('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);
    if (isFirstLogin) sendWelcomeNotification(user.id);
    req.login(user, (err) => {
      if (err) return res.status(500).json({ error: 'login_failed' });
      res.json({ ok: true, redirect: '/app/' });
    });
  } catch (err) {
    res.status(500).json({ error: 'login_failed' });
  }
});

// ── Email verification ────────────────────────────────────────────────────────
router.get('/verify-email', async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!token) return res.redirect('/?verify=invalid');
  try {
    const [rows] = await db.execute(
      'SELECT id FROM users WHERE email_verify_token = ? AND email_verify_expires > NOW()',
      [token]
    );
    if (!rows.length) return res.redirect('/?verify=expired');
    await db.execute(
      'UPDATE users SET email_verified = 1, email_verify_token = NULL, email_verify_expires = NULL WHERE id = ?',
      [rows[0].id]
    );
    res.redirect('/?verify=ok');
  } catch (err) {
    res.redirect('/?verify=error');
  }
});

router.post('/verify-email/resend', resendVerifyRateLimit, async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'not_authenticated' });
  if (req.user.email_verified) return res.json({ ok: true });
  try {
    const verifyToken = randomBytes(32).toString('hex');
    await db.execute(
      'UPDATE users SET email_verify_token = ?, email_verify_expires = DATE_ADD(NOW(), INTERVAL 24 HOUR) WHERE id = ?',
      [verifyToken, req.user.id]
    );
    const locale = await _getUserLocale(req.user.id);
    await sendVerificationEmail(req.user.email, verifyToken, locale);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'resend_failed' });
  }
});

// ── Forgot password ────────────────────────────────────────────────────────
// Two-step, and deliberately gives the exact same response either way so a
// caller can't use this to find out whether a given email has an account:
//   POST /reset-password/request — always {ok:true}; only actually emails
//                                   a link when the address matches a real
//                                   account with a password to reset.
//   POST /reset-password/confirm — sets the new password if the token is
//                                   valid and unexpired, then logs the user
//                                   straight in (they just proved account
//                                   ownership via the emailed link).
router.post('/reset-password/request', resetPasswordRateLimit, async (req, res) => {
  if (!(await _verifyTurnstile(req.body.turnstileToken, req.ip))) {
    return res.status(400).json({ error: 'captcha_failed' });
  }
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (email) {
    try {
      const [rows] = await db.execute('SELECT id FROM users WHERE email = ?', [email]);
      if (rows.length) {
        const userId = rows[0].id;
        const token  = randomBytes(32).toString('hex');
        await db.execute(
          'UPDATE users SET password_reset_token = ?, password_reset_expires = DATE_ADD(NOW(), INTERVAL 1 HOUR) WHERE id = ?',
          [token, userId]
        );
        const locale = await _getUserLocale(userId);
        sendPasswordResetEmail(email, token, locale)
          .catch(err => console.error('[auth/reset-password/request] email failed:', err.message));
      }
    } catch (err) {
      console.error('[auth/reset-password/request]', err.message);
      // fall through to the same generic response — never reveal failure detail
    }
  }
  res.json({ ok: true });
});

router.post('/reset-password/confirm', async (req, res) => {
  const { token, newPassword } = req.body;
  if (typeof token !== 'string' || !token) return res.status(400).json({ error: 'invalid_token' });
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ error: 'weak_password' });
  }
  try {
    const [rows] = await db.execute(
      'SELECT * FROM users WHERE password_reset_token = ? AND password_reset_expires > NOW()',
      [token]
    );
    if (!rows.length) return res.status(400).json({ error: 'invalid_or_expired_token' });

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await db.execute(
      'UPDATE users SET password_hash = ?, password_reset_token = NULL, password_reset_expires = NULL WHERE id = ?',
      [passwordHash, rows[0].id]
    );

    const [updated] = await db.execute('SELECT * FROM users WHERE id = ?', [rows[0].id]);
    req.login(updated[0], (err) => {
      if (err) return res.json({ ok: true }); // password is set either way; login is just a convenience
      res.json({ ok: true, redirect: '/app/' });
    });
  } catch (err) {
    console.error('[auth/reset-password/confirm]', err.message);
    res.status(500).json({ error: 'reset_failed' });
  }
});

module.exports = router;
