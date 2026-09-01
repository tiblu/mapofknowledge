require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

// ── Required environment variables — fail loudly at startup, not silently.
// Must run before any route module is required: auth.js registers Google's
// OAuth strategy at require-time using GOOGLE_CLIENT_ID/SECRET/BASE_URL, and
// SESSION_SECRET used to fall back to a hardcoded public string if unset,
// which would have made every session cookie forgeable — there is no safe
// default for it, so a missing value must stop the server, not degrade it.
const REQUIRED_ENV_VARS = [
  'SESSION_SECRET',
  'DB_HOST', 'DB_USER', 'DB_PASS', 'DB_NAME',
  'ANTHROPIC_API_KEY',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'BASE_URL',
];
const missingEnvVars = REQUIRED_ENV_VARS.filter(name => !process.env[name]);
if (missingEnvVars.length) {
  console.error(`FATAL: missing required environment variable(s): ${missingEnvVars.join(', ')}`);
  console.error('Set these in .env before starting the server — refusing to start with broken/insecure configuration.');
  process.exit(1);
}

const express  = require('express');
const helmet   = require('helmet');
const cookieSession = require('cookie-session');
const passport = require('passport');
const path     = require('path');

const authRouter     = require('./routes/auth');   // also registers passport strategy
const apiRouter      = require('./routes/api');
const subsetsRouter  = require('./routes/subsets');
const adminRouter    = require('./routes/admin');
const accountRouter  = require('./routes/account');
const knowledgeEstimateRouter = require('./routes/knowledgeEstimate');
const webauthnRouter = require('./routes/webauthn');
const requireAuth = require('./middleware/requireAuth');

const app = express();

// Security headers — deliberately only the 4 discussed and approved
// 2026-09-01, everything else helmet would add by default is explicitly
// turned off below rather than shipped silently:
//   - X-Frame-Options: 'sameorigin' (not helmet's other option, 'deny') —
//     app/index.html's #page-overlay-frame embeds profile/settings/
//     notifications/help/account/custom-map as same-origin iframes, which
//     'deny' would break.
//   - X-Content-Type-Options: nosniff
//   - Referrer-Policy: no-referrer (helmet's default)
//   - Strict-Transport-Security: safe to enable — plain HTTP already 301s
//     to HTTPS at the Apache level (verified 2026-09-01), so this only
//     skips that round-trip on repeat visits, nothing more.
// Content-Security-Policy is OFF for now — the default policy would break
// gtag.js, the Cloudflare Turnstile widget, Google Fonts, and the inline
// <script> blocks on every page; it needs a real allowlist pass as its own
// follow-up, not a blind default. Cross-Origin-Opener-Policy/-Resource-
// Policy, Origin-Agent-Cluster, X-Powered-By removal, and the rest of
// helmet's bundle are also off — not discussed yet, revisit deliberately
// rather than accepting them as a side effect of adding helmet.
app.use(helmet({
  contentSecurityPolicy: false,
  frameguard: { action: 'sameorigin' },
  hsts: true,
  noSniff: true,
  referrerPolicy: true,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false,
  crossOriginEmbedderPolicy: false,
  originAgentCluster: false,
  xssFilter: false,
  dnsPrefetchControl: false,
  ieNoOpen: false,
  permittedCrossDomainPolicies: false,
  hidePoweredBy: false,
}));

// Node listens on a Unix socket (Apache proxies to it via .htaccess), so
// req.socket.remoteAddress has no meaningful value on its own — trust the
// single Apache hop's X-Forwarded-For (added automatically by mod_proxy_http)
// so req.ip resolves to the real client IP. Needed for per-IP rate limiting
// on the pre-auth routes in auth.js (login/signup have no req.user yet).
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Session (cookie-based — survives server restarts) ─────────────────────────
app.use(cookieSession({
  name: 'session',
  secret: process.env.SESSION_SECRET,
  maxAge: 7 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  secure: false, // Apache terminates TLS; Node sees plain HTTP on port 3000
  sameSite: 'lax', // baseline CSRF protection — cookie isn't sent on cross-site POST/DELETE
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
app.use('/auth/webauthn', webauthnRouter);

// Protected API
app.use('/api', requireAuth, apiRouter);
app.use('/api/subsets', requireAuth, subsetsRouter);
app.use('/api/admin', requireAuth, adminRouter);
app.use('/api/account', requireAuth, accountRouter);
app.use('/api/knowledge-estimate', requireAuth, knowledgeEstimateRouter);

// Protected app (the D3 knowledge map)
app.use('/app', requireAuth, express.static(path.join(__dirname, '../app')));

// Signup page (explicit route so /signup works without .html extension)
app.get('/signup', (req, res) => res.sendFile(path.join(__dirname, '../signup.html')));

// Public landing page and other static assets at root
app.use(express.static(path.join(__dirname, '..')));

// Health check
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

module.exports = app;
