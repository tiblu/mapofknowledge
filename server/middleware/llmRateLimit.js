// Per-user token bucket, shared across every LLM-calling route it's applied
// to — the actual cost concern is a user's total LLM spend per minute, not
// spend on any one route in isolation.
//
// Capacity 15 / refill 1 token per 3s (~20/min sustained): generous enough
// that no human clicking through the UI as fast as physically possible ever
// notices it (each call already takes several seconds to stream back), but
// cuts a script doing hundreds or thousands of calls/minute down to ~20/min.
//
// In-memory Map is fine here — mok-server runs single-process PM2 fork mode,
// not clustered, so there's no cross-instance state to reconcile.
const BUCKET_CAPACITY    = 15;
const REFILL_INTERVAL_MS = 3000;
const STALE_BUCKET_MS    = 10 * 60 * 1000; // untouched for 10min = safe to drop (would be back at full capacity anyway)
const SWEEP_INTERVAL_MS  = 30 * 60 * 1000;

const _buckets = new Map(); // userId -> { tokens, lastRefill, lastSeen }

setInterval(() => {
  const cutoff = Date.now() - STALE_BUCKET_MS;
  for (const [userId, bucket] of _buckets) {
    if (bucket.lastSeen < cutoff) _buckets.delete(userId);
  }
}, SWEEP_INTERVAL_MS).unref();

function llmRateLimit(req, res, next) {
  const userId = req.user?.id;
  if (!userId) return next(); // requireAuth already guards every route this is mounted on; defensive only

  const now = Date.now();
  let bucket = _buckets.get(userId);
  if (!bucket) {
    bucket = { tokens: BUCKET_CAPACITY, lastRefill: now, lastSeen: now };
    _buckets.set(userId, bucket);
  }
  bucket.lastSeen = now;

  const refills = Math.floor((now - bucket.lastRefill) / REFILL_INTERVAL_MS);
  if (refills > 0) {
    bucket.tokens = Math.min(BUCKET_CAPACITY, bucket.tokens + refills);
    bucket.lastRefill += refills * REFILL_INTERVAL_MS;
  }

  if (bucket.tokens < 1) {
    const retryMs = REFILL_INTERVAL_MS - (now - bucket.lastRefill);
    res.setHeader('Retry-After', Math.ceil(retryMs / 1000));
    return res.status(429).json({ error: 'rate_limited', retryAfterMs: retryMs });
  }

  bucket.tokens -= 1;
  next();
}

module.exports = llmRateLimit;
