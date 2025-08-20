const WINDOW = {
    burstMs: 10 * 60 * 1000,
    dayMs: 24 * 60 * 60 * 1000,
};

function makeFixedWindowLimiter(max, windowMs, keyFn) {
    const buckets = new Map();
    return function limiter(req, res, next) {
        const key = keyFn(req);
        const now = Date.now();
        let b = buckets.get(key);
        if (!b || now >= b.resetAt) {
            b = { count: 0, resetAt: now + windowMs };
            buckets.set(key, b);
        }
        b.count += 1;
        const remaining = Math.max(0, max - b.count);
        res.setHeader('X-RateLimit-Limit', String(max));
        res.setHeader('X-RateLimit-Remaining', String(remaining));
        res.setHeader('X-RateLimit-Reset', String(b.resetAt));
        if (b.count > max)
            return res.status(429).json({ error: 'rate_limited' });
        next();
    };
}

const ipBurstLimiter = makeFixedWindowLimiter(
    12,
    WINDOW.burstMs,
    req =>
        req.headers['x-forwarded-for']?.toString().split(',')[0].trim() ||
        req.socket.remoteAddress ||
        'ip:unknown'
);

const emailDayLimiter = makeFixedWindowLimiter(10, WINDOW.dayMs, req => {
    const email = (req.body?.email || '').toLowerCase().trim();
    return email ? `email:${email}` : 'email:missing';
});

module.exports = { ipBurstLimiter, emailDayLimiter };
