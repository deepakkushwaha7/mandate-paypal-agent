// HTTP hardening without extra dependencies.
//
//  - Security headers: CSP, no framing, no MIME sniffing, strict referrer.
//  - Same-origin check for browser writes (blocks cross-site request forgery).
//  - Per-IP rate limit for the API.
// External agents use /api/agents/* with a bearer token instead of cookies,
// so the origin check does not apply to them. PayPal webhooks are verified
// by signature, so they are exempt too.

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // AG Grid and the meters set element positions with inline style attributes.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

function headers(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (req.secure || req.get('x-forwarded-proto') === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const EXEMPT = [/^\/api\/agents\/[^/]+\/(check|purchase)$/, /^\/paypal\/webhook$/];

function sameOrigin(req, res, next) {
  if (!WRITE.has(req.method) || EXEMPT.some((r) => r.test(req.path))) return next();
  const origin = req.get('origin');
  const host = req.get('x-forwarded-host') || req.get('host');
  if (origin) {
    try {
      if (new URL(origin).host === host) return next();
    } catch (_) {
      /* fall through */
    }
    return res.status(403).json({ error: 'Cross-site request blocked.' });
  }
  // No Origin header: allow same-site form posts (simulated PayPal page) and
  // non-browser clients such as tests and curl. Browsers always send Origin
  // on cross-site fetch/XHR, so CSRF from another site is still blocked.
  const site = req.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return res.status(403).json({ error: 'Cross-site request blocked.' });
  return next();
}

function rateLimit({ windowMs = 60000, max = 240 } = {}) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs);
  timer.unref();
  return (req, res, next) => {
    const key = req.ip || 'local';
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset < now) {
      h = { n: 0, reset: now + windowMs };
      hits.set(key, h);
    }
    h.n += 1;
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - h.n)));
    if (h.n > max) return res.status(429).json({ error: 'Too many requests. Wait a minute and try again.' });
    return next();
  };
}

module.exports = { headers, sameOrigin, rateLimit, CSP };
