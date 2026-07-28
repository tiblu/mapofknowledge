require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express  = require('express');
const cookieSession = require('cookie-session');
const passport = require('passport');
const path     = require('path');

const authRouter     = require('./routes/auth');   // also registers passport strategy
const apiRouter      = require('./routes/api');
const subsetsRouter  = require('./routes/subsets');
const adminRouter    = require('./routes/admin');
const requireAuth = require('./middleware/requireAuth');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Session (cookie-based — survives server restarts) ─────────────────────────
app.use(cookieSession({
  name: 'session',
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  maxAge: 7 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  secure: false, // Apache terminates TLS; Node sees plain HTTP on port 3000
}));

// Passport 0.7+ requires these methods; cookie-session doesn't provide them
app.use((req, res, next) => {
  if (req.session && !req.session.regenerate) req.session.regenerate = cb => cb();
  if (req.session && !req.session.save) req.session.save = cb => cb();
  next();
});

app.use(passport.initialize());
app.use(passport.session());

// ── Routes ────────────────────────────────────────────────────────────────────
// Public auth endpoints
app.use('/auth', authRouter);

// Protected API
app.use('/api', requireAuth, apiRouter);
app.use('/api/subsets', requireAuth, subsetsRouter);
app.use('/api/admin', requireAuth, adminRouter);

// Protected app (the D3 knowledge map)
app.use('/app', requireAuth, express.static(path.join(__dirname, '../app')));

// Public landing page and other static assets at root
app.use(express.static(path.join(__dirname, '..')));

// Health check
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

module.exports = app;
