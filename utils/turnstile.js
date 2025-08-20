const axios = require('axios');

async function verifyTurnstile(token, remoteip) {
    if (process.env.TURNSTILE_ENABLED !== 'true') return true;
    if (!token) { console.warn('[turnstile] missing token'); return false; }
    const secret = process.env.TURNSTILE_SECRET_KEY;
    if (!secret) throw new Error('TURNSTILE_SECRET_KEY missing');

    const resp = await axios.post(
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
        new URLSearchParams({
            secret,
            response: token,
            remoteip: remoteip || '',
        }),
        { timeout: 8000 }
    );
    return !!resp.data?.success;
}

module.exports = { verifyTurnstile };
