// Redirects unauthenticated requests for /app/* and /api/* to the landing page.
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  // req.path is relative to whatever prefix this middleware is mounted at
  // (e.g. '/settings' when mounted via app.use('/api', requireAuth, apiRouter)),
  // so it never actually starts with '/api/' — req.originalUrl keeps the full
  // request path regardless of mount depth and is the reliable check here.
  if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  return res.redirect('/');
}

module.exports = requireAuth;
