const express  = require('express');
const passport = require('passport');
const bcrypt   = require('bcrypt');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { randomUUID, randomBytes } = require('crypto');
const db       = require('../db');
const { notify, getUserLocale } = require('../services/notifications');
const { moderateTags } = require('../services/llm');
const { sendVerificationEmail } = require('../services/mailer');
const { redeemLinkCode } = require('../services/links');
const router   = express.Router();

// ── Shared signup helpers ───────────────────────────────────────────────────
// Validates + moderates the wizard payload (role, plan, personal fields,
// interests/values, etc). Used by both the Google-deferred prepare step and
// the direct email+password signup — the DB write only differs in how the
// `users` row itself gets created (password_hash vs OAuth-only).
async function buildPendingSignup(body) {
  const { role, plan, birthYear, idNumber, displayName, about, qualification, linkCode, interests, values } = body;
  const validRoles = ['learner', 'teacher', 'parent'];
  const validPlans = ['free', 'subscriber'];

  let validQualification = null;
  if (qualification && typeof qualification === 'object') {
    const { title, issuer, year } = qualification;
    const yearNum = Number(year);
    if (typeof title === 'string' && title.trim()
      && typeof issuer === 'string' && issuer.trim()
      && Number.isInteger(yearNum) && yearNum > 1900 && yearNum < 2100) {
      validQualification = {
        title:  title.trim().slice(0, 255),
        issuer: issuer.trim().slice(0, 255),
        year:   yearNum,
      };
    }
  }

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

  return {
    ok: true,
    pending: {
      role:        validRoles.includes(role) ? role : 'learner',
      plan:        validPlans.includes(plan) ? plan : 'free',
      birthYear:   typeof birthYear === 'number' && birthYear > 1900 ? birthYear : null,
      // Estonian ID code — 11 digits, already checksum-validated client-side;
      // re-validate the shape server-side rather than trust it blindly.
      idNumber:    typeof idNumber === 'string' && /^\d{11}$/.test(idNumber) ? idNumber : null,
      displayName: typeof displayName === 'string' && displayName.trim() ? displayName.trim().slice(0, 255) : null,
      // School + grade (or school + subject for teachers), composed
      // client-side (see buildAboutText in signup.html) for the
      // "Õpivajadused ja -eelistused" profile field.
      about:       typeof about === 'string' && about.trim() ? about.trim().slice(0, 1000) : null,
      // Parent's education level + institution + year -> "Kvalifikatsioonid".
      qualification: validQualification,
      // Code a teacher/parent generated on their own profile page and handed
      // to this student out-of-band — consumed once the account is created.
      linkCode: typeof linkCode === 'string' && /^[A-Z0-9]{8}$/i.test(linkCode.trim()) ? linkCode.trim().toUpperCase() : null,
      // Core interests / values -> passport_tags.
      interests: validInterests,
      values:    validValues,
    },
  };
}

async function createPassportFromPending(conn, pending) {
  const [pr] = await conn.execute(
    'INSERT INTO learner_passports (public_id, birth_year, id_number, display_name, about) VALUES (?, ?, ?, ?, ?)',
    [randomUUID(), pending.birthYear || null, pending.idNumber || null, pending.displayName || null, pending.about || null]
  );
  const passportId = pr.insertId;

  if (pending.qualification) {
    await conn.execute(
      `INSERT INTO passport_credentials (passport_id, type, title, issuer, awarded_date, sort_order)
       VALUES (?, 'qualification', ?, ?, ?, 0)`,
      [passportId, pending.qualification.title, pending.qualification.issuer, pending.qualification.year + '-01-01']
    );
  }

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

// A code entered during signup is only ever collected on the learner
// role-tab, so pending.role is always 'learner' here — same eligibility
// rules as redeeming from Settings apply (role.learner + age <= 20). Fails
// silently: this field is optional, and a bad code shouldn't block signup —
// the learner can always enter it again later from Seaded.
async function consumeLinkCode(pending, passportId, userId) {
  if (!pending.linkCode) return;
  await redeemLinkCode({
    passportId,
    userId,
    userRole: pending.role,
    birthYear: pending.birthYear,
    code: pending.linkCode,
  });
}

function sendWelcomeNotification(userId, locale) {
  notify(userId, 'welcome',
    locale === 'et' ? 'Tere tulemast KnoBitz-i!' : 'Welcome to KnoBitz!',
    locale === 'et'
      ? 'Oleme rõõmsad, et oled siin. Alusta kaardi uurimisega ja jõua teadmistes kaugemale!'
      : "We're glad you're here. Start exploring the map and go further in your knowledge!");
}

function roleRedirect(role) {
  if (role === 'teacher') return '/app/teacher.html';
  if (role === 'parent')  return '/app/parent.html';
  return '/app/';
}

// First-ever login always lands on the map — the guided tour only exists
// there (tour.js isn't loaded on teacher.html/parent.html), and it self-gates
// on a per-user localStorage flag so it only ever shows once. Every login
// after that goes straight to the role's default view.
function landingRedirect(role, isFirstLogin) {
  return isFirstLogin ? '/app/' : roleRedirect(role);
}

// ── Passport setup — Google ─────────────────────────────────────────────────
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
        const [users] = await conn.execute(
          'SELECT * FROM users WHERE email = ?', [email]
        );

        if (users.length === 0) {
          // No existing account — only allow if a signup flow was prepared
          const pending = req.session && req.session.pendingSignup;
          if (!pending) return done(null, false);

          const passportId = await createPassportFromPending(conn, pending);
          const subStatus = pending.plan === 'subscriber' ? 'subscriber' : 'free';

          const [ur] = await conn.execute(
            `INSERT INTO users (email, role, email_verified, subscription_status, passport_id, last_login, created_at)
             VALUES (?, ?, 1, ?, ?, NOW(), NOW())`,
            [email, pending.role, subStatus, passportId]
          );
          const userId = ur.insertId;

          if (subStatus === 'subscriber') {
            await conn.execute(
              `UPDATE users SET subscription_period_end = DATE_ADD(NOW(), INTERVAL 1 MONTH)
               WHERE id = ?`,
              [userId]
            );
          }

          await consumeLinkCode(pending, passportId, userId);

          req.session.pendingSignup = null;

          const signupLocale = await getUserLocale(userId);
          sendWelcomeNotification(userId, signupLocale);

          const [newUsers] = await conn.execute(
            'SELECT * FROM users WHERE id = ?', [userId]
          );
          const newUser = newUsers[0];
          newUser._isFirstLogin = true;
          return done(null, newUser);
        }

        // Existing user — normal login
        const user = users[0];
        const isFirstLogin = !user.last_login;
        await conn.execute('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);
        if (isFirstLogin) {
          const loginLocale = await getUserLocale(user.id);
          notify(user.id, 'welcome',
            loginLocale === 'et' ? 'Tere tulemast KnoBitz-i!' : 'Welcome to KnoBitz!',
            loginLocale === 'et'
              ? 'Oleme rõõmsad, et oled siin. Alusta kaardi uurimisega!'
              : "We're glad you're here. Start exploring the map!");
        }
        user._isFirstLogin = isFirstLogin;
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
  (req, res) => {
    res.redirect(landingRedirect(req.user && req.user.role, req.user && req.user._isFirstLogin));
  }
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
    hasPassword: !!password_hash,
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
    const subStatus    = pending.plan === 'subscriber' ? 'subscriber' : 'free';

    const [ur] = await conn.execute(
      `INSERT INTO users (email, password_hash, email_verified, email_verify_token, email_verify_expires,
                           role, subscription_status, passport_id, last_login, created_at)
       VALUES (?, ?, 0, ?, DATE_ADD(NOW(), INTERVAL 24 HOUR), ?, ?, ?, NOW(), NOW())`,
      [normEmail, passwordHash, verifyToken, pending.role, subStatus, passportId]
    );
    const userId = ur.insertId;

    if (subStatus === 'subscriber') {
      await conn.execute(
        `UPDATE users SET subscription_period_end = DATE_ADD(NOW(), INTERVAL 1 MONTH) WHERE id = ?`,
        [userId]
      );
    }

    await consumeLinkCode(pending, passportId, userId);

    const signupLocale = await getUserLocale(userId);
    sendWelcomeNotification(userId, signupLocale);
    sendVerificationEmail(normEmail, verifyToken, signupLocale)
      .catch(err => console.error('[auth/signup/password] verification email failed:', err.message));

    const [newUsers] = await conn.execute('SELECT * FROM users WHERE id = ?', [userId]);
    req.login(newUsers[0], (err) => {
      if (err) return res.status(500).json({ error: 'login_failed' });
      res.json({ ok: true, redirect: landingRedirect(pending.role, true) });
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
    req.login(user, (err) => {
      if (err) return res.status(500).json({ error: 'login_failed' });
      res.json({ ok: true, redirect: landingRedirect(user.role, isFirstLogin) });
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
    const locale = await getUserLocale(req.user.id);
    await sendVerificationEmail(req.user.email, verifyToken, locale);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'resend_failed' });
  }
});

module.exports = router;
