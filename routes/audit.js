const express = require('express');
const router = express.Router();
const path = require('path');
const ejs = require('ejs');
const fs = require('fs').promises;
const crypto = require('crypto');
const { scrapePage } = require('../utils/scrape');
const { generateAudit } = require('../utils/openai-client');
const { renderPdfFromHtml } = require('../utils/pdf');
const { sendEmailWithAttachment } = require('../utils/mailer');

const seen = new Map();
const TTL_MS = 10 * 60 * 1000;

function getIdempotencyKey(req) {
    const hdr =
        req.headers['framer-webhook-submission-id'] ||
        req.headers['x-request-id'] ||
        '';
    if (hdr) return `hdr:${hdr}`;

    const hash = crypto
        .createHash('sha256')
        .update(JSON.stringify(req.body || {}))
        .digest('hex');
    return `body:${hash}`;
}

function markSeen(key) {
    seen.set(key, Date.now());
    setTimeout(() => seen.delete(key), TTL_MS);
}

const isValidEmail = email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const isValidUrl = url => {
    try {
        const u = new URL(url);
        return ['airbnb.com', 'booking.com', 'vrbo.com'].some(d =>
            u.hostname.includes(d)
        );
    } catch {
        return false;
    }
};

const fallbackTpl = `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:Arial,sans-serif;margin:32px}pre{white-space:pre-wrap}
</style></head><body>
<h1>Hospitri — Listing Audit</h1>
<p><b>URL:</b> <%= url %></p>
<p><b>Overall:</b> <%= audit.overall_score %></p>
<pre><%= JSON.stringify(audit, null, 2) %></pre>
</body></html>`;

router.post('/', async (req, res) => {
    const { name, email, phone, url } = req.body || {};

    if (!url || !email || !name)
        return res.status(400).json({ error: 'name, email and url required' });
    if (!isValidEmail(email))
        return res.status(400).json({ error: 'invalid email format' });
    if (!isValidUrl(url))
        return res.status(400).json({ error: 'invalid or unsupported URL' });

    const key = getIdempotencyKey(req);
    if (seen.has(key)) {
        return res.status(202).json({ ok: true, duplicate: true });
    }
    markSeen(key);

    res.status(202).json({ ok: true, received: true });

    (async () => {
        try {
            const html = await scrapePage(url);
            const auditJson = await generateAudit({ html });

            const templatePath = path.resolve(
                __dirname,
                '..',
                'templates',
                'audit-template.ejs'
            );
            let str;
            try {
                const tpl = await fs.readFile(templatePath, 'utf8');
                str = ejs.render(tpl, { audit: auditJson, url, name });
            } catch {
                str = ejs.render(fallbackTpl, {
                    audit: auditJson,
                    url,
                    name,
                });
            }

            const pdfPath = await renderPdfFromHtml(str);

            await sendEmailWithAttachment({
                to: email,
                subject: `Hospitri — Audit for ${url}`,
                html: `<p>Hi ${name},</p><p>Attached is your audit for <b>${url}</b>.</p>`,
                attachmentPath: pdfPath,
            });
            console.log('Audit sent OK', { email, url });
        } catch (err) {
            console.error('Background processing failed:', err);
        }
    })();
});

module.exports = router;
