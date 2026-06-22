const express  = require('express');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const db       = require('../db');
const { notify } = require('../services/notifications');
const router   = express.Router();

// Accounts that get elevated roles on first login.
const ROLE_MAP = {
  'margo.loor@gmail.com':      'super_admin',
  'hannes.tamjarv@meta.ee':    'learner',
};

// ── Passport setup ────────────────────────────────────────────────────────────
passport.use(new GoogleStrategy(
  {
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  process.env.BASE_URL + '/auth/google/callback',
  },
  async (accessToken, refreshToken, profile, done) => {
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
          // No pre-existing account — deny login
          return done(null, false);
        }

        const user = users[0];
        const isFirstLogin = !user.last_login;
        await conn.execute('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);
        if (isFirstLogin) {
          notify(user.id, 'welcome', 'Welcome to KnobitMap!',
            'We\'re glad you\'re here. Start exploring the map and begin your journey of discovery. Happy learning!');
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
  const { id, email, role, passport_id } = req.user;
  res.json({ id, email, role, passport_id });
});

module.exports = router;
