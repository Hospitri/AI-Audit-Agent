const express = require('express');
const crypto = require('crypto');
const router = express.Router();

function sha256HexNorm(s) {
    if (s == null) return null;
    const v = String(s).trim().toLowerCase();
    return crypto.createHash('sha256').update(v, 'utf8').digest('hex');
}

router.post('/', (req, res) => {
    try {
        const { email, phone, firstName, lastName } = req.body || {};
        const out = {};
        if (email) out.em = sha256HexNorm(email);
        if (phone) out.ph = sha256HexNorm(phone);
        if (firstName) out.fn = sha256HexNorm(firstName);
        if (lastName) out.ln = sha256HexNorm(lastName);
        return res.json({ ok: true, hashed: out });
    } catch (err) {
        console.error('hash-pii err', err);
        return res.status(500).json({ ok: false, error: 'server_error' });
    }
});

module.exports = router;
