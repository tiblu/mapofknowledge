const express  = require('express');
const passport = require('passport');
const bcrypt   = require('bcryptjs'); // pure-JS — no native compile step, safer on shared hosting
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { randomUUID, randomBytes } = require('crypto');
const db       = require('../db');
const { notify } = require('../services/notifications');
const { moderateTags } = require('../services/llm');
const { sendVerificationEmail } = require('../services/mailer');
const router   = express.Router();

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
      const email = profile.emails?.[0]?.value?.toLowerCase();
      if (!email) return done(new Error('No email from Google'));

      const conn = await db.getConnection();
      try {
        // Find or create user
        const [users] = await conn.execute(
          'SELECT * FROM users WHERE email = ?', [email]
        );

        if (users.length === 0) {
          // No existing account — only allow if a signup flow was prepared
          const pending = req.session && req.session.pendingSignup;
          if (!pending) return done(null, false);

          const passportId = await createPassportFromPending(conn, pending);

          const [ur] = await conn.execute(
            `INSERT INTO users (email, role, email_verified, subscription_status, passport_id, last_login, created_at)
             VALUES (?, ?, 1, 'free', ?, NOW(), NOW())`,
            [email, ROLE_MAP[email] || 'learner', passportId]
          );
          const userId = ur.insertId;

          req.session.pendingSignup = null;
          sendWelcomeNotification(userId);

          const [newUsers] = await conn.execute('SELECT * FROM users WHERE id = ?', [userId]);
          return done(null, newUsers[0]);
        }

        // Existing user — normal login
        const user = users[0];
        const isFirstLogin = !user.last_login;
        await conn.execute('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);
        if (isFirstLogin) sendWelcomeNotification(user.id);
        done(null, user);
      } finally {
        conn.release();
      }
    } catch (err) {
      done(err);
    }
  }
));

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
router.post('/signup/prepare', async (req, res) => {
  const built = await buildPendingSignup(req.body);
  if (!built.ok) return res.status(built.status).json(built.body);
  req.session.pendingSignup = built.pending;
  res.json({ ok: true });
});

// ── Signup with email + password — creates the account immediately ───────────
router.post('/signup/password', async (req, res) => {
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
router.post('/login', async (req, res) => {
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

router.post('/verify-email/resend', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'not_authenticated' });
  if (req.user.email_verified) return res.json({ ok: true });
  try {
    const verifyToken = randomBytes(32).toString('hex');
    await db.execute(
      'UPDATE users SET email_verify_token = ?, email_verify_expires = DATE_ADD(NOW(), INTERVAL 24 HOUR) WHERE id = ?',
      [verifyToken, req.user.id]
    );
    await sendVerificationEmail(req.user.email, verifyToken, 'en');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'resend_failed' });
  }
});

module.exports = router;
