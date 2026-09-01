// Per-IP (or per-user, for the one authenticated case) token buckets for the
// pre-authentication endpoints in auth.js — login, signup, and verify-email
// resend. These have no req.user to key by the way llmRateLimit.js does (no
// account exists yet, or the whole point is proving you own one), so they're
// keyed by IP instead. Requires app.set('trust proxy', 1) in server/app.js —
// without it req.ip is the meaningless Unix-socket connection address, not
// the real client behind Apache.
//
// Tighter than the LLM limiter on purpose: login is a brute-force target,
// and signup/resend both end in an email send once SMTP is configured.
// Ported from themapofknowledge.com's 2026-09-01 review.

function _makeLimiter(capacity, refillIntervalMs, keyFn) {
  const buckets = new Map();
  const STALE_MS = 30 * 60 * 1000;
  setInterval(() => {
    const cutoff = Date.now() - STALE_MS;
    for (const [key, b] of buckets) {
      if (b.lastSeen < cutoff) buckets.delete(key);
    }
  }, STALE_MS).unref();

  return function (req, res, next) {
    const key = keyFn(req) || 'unknown';
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, lastRefill: now, lastSeen: now };
      buckets.set(key, bucket);
    }
    bucket.lastSeen = now;

    const refills = Math.floor((now - bucket.lastRefill) / refillIntervalMs);
    if (refills > 0) {
      bucket.tokens = Math.min(capacity, bucket.tokens + refills);
      bucket.lastRefill += refills * refillIntervalMs;
    }

    if (bucket.tokens < 1) {
      const retryMs = refillIntervalMs - (now - bucket.lastRefill);
      res.setHeader('Retry-After', Math.ceil(retryMs / 1000));
      return res.status(429).json({ error: 'rate_limited', retryAfterMs: retryMs });
    }

    bucket.tokens -= 1;
    next();
  };
}

const _byIp     = (req) => req.ip;
const _byUserId = (req) => req.user && req.user.id;

// Login: 8 attempts, refilling 1 per 2 minutes (~30/hr sustained) per IP —
// makes password brute-forcing infeasible without blocking someone who
// mistypes their password a few times in a row.
const loginRateLimit = _makeLimiter(8, 2 * 60 * 1000, _byIp);

// Signup (prepare + password): 5 attempts, refilling 1 per 5 minutes
// (~12/hr sustained) per IP — bounds both account-creation spam and the
// verification email each successful signup sends.
const signupRateLimit = _makeLimiter(5, 5 * 60 * 1000, _byIp);

// Verify-email resend: already requires an authenticated session and only
// ever emails the caller's own address, so this is self-spam protection —
// keyed by user id, 3 attempts refilling 1 per 5 minutes.
const resendVerifyRateLimit = _makeLimiter(3, 5 * 60 * 1000, _byUserId);

// Password-reset request: unauthenticated by definition (that's the whole
// point) and sends an email, same shape of risk as signup — 5 attempts,
// refilling 1 per 5 minutes, per IP.
const resetPasswordRateLimit = _makeLimiter(5, 5 * 60 * 1000, _byIp);

module.exports = {
  loginRateLimit, signupRateLimit, resendVerifyRateLimit, resetPasswordRateLimit,
};
