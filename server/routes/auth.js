const express  = require('express');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { randomUUID } = require('crypto');
const db       = require('../db');
const { notify } = require('../services/notifications');
const router   = express.Router();

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
        const [users] = await conn.execute(
          'SELECT * FROM users WHERE email = ?', [email]
        );

        if (users.length === 0) {
          // No existing account — only allow if a signup flow was prepared
          const pending = req.session && req.session.pendingSignup;
          if (!pending) return done(null, false);

          const role      = pending.role || 'learner';
          const plan      = pending.plan || 'free';
          const subStatus = plan === 'subscriber' ? 'subscriber' : 'free';

          // Learners get a passport; teachers and parents do not (yet)
          let passportId = null;
          if (role === 'learner') {
            const [pr] = await conn.execute(
              'INSERT INTO learner_passports (public_id, birth_year) VALUES (?, ?)',
              [randomUUID(), pending.birthYear || null]
            );
            passportId = pr.insertId;
          }

          const [ur] = await conn.execute(
            `INSERT INTO users (email, role, subscription_status, passport_id, last_login, created_at)
             VALUES (?, ?, ?, ?, NOW(), NOW())`,
            [email, role, subStatus, passportId]
          );
          const userId = ur.insertId;

          if (subStatus === 'subscriber') {
            await conn.execute(
              `UPDATE users SET subscription_period_end = DATE_ADD(NOW(), INTERVAL 1 MONTH)
               WHERE id = ?`,
              [userId]
            );
          }

          req.session.pendingSignup = null;

          notify(userId, 'welcome', 'Tere tulemast Knobitz-i!',
            'Oleme rõõmsad, et oled siin. Alusta kaardi uurimisega ja jõua teadmistes kaugemale!');

          const [newUsers] = await conn.execute(
            'SELECT * FROM users WHERE id = ?', [userId]
          );
          return done(null, newUsers[0]);
        }

        // Existing user — normal login
        const user = users[0];
        const isFirstLogin = !user.last_login;
        await conn.execute('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);
        if (isFirstLogin) {
          notify(user.id, 'welcome', 'Tere tulemast Knobitz-i!',
            'Oleme rõõmsad, et oled siin. Alusta kaardi uurimisega!');
        }
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

// ── Routes ────────────────────────────────────────────────────────────────────
router.get('/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: '/?auth=failed' }),
  (req, res) => {
    const role = req.user && req.user.role;
    if (role === 'teacher') return res.redirect('/app/teacher.html');
    if (role === 'parent')  return res.redirect('/app/parent.html');
    res.redirect('/app/');
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
  const { id, email, role, passport_id, subscription_status } = req.user;
  res.json({ id, email, role, passport_id, subscription_status });
});

// ── Signup prepare — stores intent in session before Google OAuth ─────────────
router.post('/signup/prepare', (req, res) => {
  const { role, plan, birthYear } = req.body;
  const validRoles = ['learner', 'teacher', 'parent'];
  const validPlans = ['free', 'subscriber'];
  req.session.pendingSignup = {
    role:      validRoles.includes(role) ? role : 'learner',
    plan:      validPlans.includes(plan) ? plan : 'free',
    birthYear: typeof birthYear === 'number' && birthYear > 1900 ? birthYear : null,
  };
  res.json({ ok: true });
});

module.exports = router;
