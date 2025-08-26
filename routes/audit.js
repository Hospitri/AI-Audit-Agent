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
const { pool } = require('../utils/db');
const { idBySlug } = require('../utils/lookups');
const { insertLead, addLeadToList, insertAudit } = require('../utils/store');
const { ipBurstLimiter, emailDayLimiter } = require('../utils/rateLimit');
const { verifyTurnstile } = require('../utils/turnstile');
const { acquire } = require('../utils/concurrency');
const { upsertPerson, addToAuditList } = require('../utils/attio');
const { t } = require('../utils/metrics');

function ipLimiterOrBypass(req, res, next) {
    const ua = (req.headers['user-agent'] || '').toLowerCase();
    if (ua.includes('framer/webhooks')) return next();
    return ipBurstLimiter(req, res, next);
}

router.use(ipLimiterOrBypass);
router.use(emailDayLimiter);

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
    const TURNSTILE_BYPASS = process.env.TURNSTILE_BYPASS === '1';
    const tsToken =
        req.body?.['cf-turnstile-response'] || req.body?.turnstileToken;
    const remoteip =
        req.headers['x-forwarded-for']?.toString().split(',')[0].trim() ||
        req.socket.remoteAddress;
    const submissionId = req.headers['framer-webhook-submission-id'] || '';
    const { name, email, phone, url } = req.body || {};
    console.log("**//Phone Number:", phone);

    if (!url || !email || !name)
        return res.status(400).json({ error: 'name, email and url required' });
    if (!isValidEmail(email))
        return res.status(400).json({ error: 'invalid email format' });
    if (!isValidUrl(url))
        return res.status(400).json({ error: 'invalid or unsupported URL' });

    const okTs = TURNSTILE_BYPASS
        ? true
        : await verifyTurnstile(tsToken, remoteip);

    if (!okTs) {
        t('captcha_fail')({ submission_id: submissionId || null, email, url });
        res.set('X-Turnstile', 'fail');
        return res.status(403).json({ error: 'captcha_failed' });
    }

    t('form_received')({
        submission_id: submissionId || null,
        email,
        url,
        props: { ua: req.headers['user-agent'] || '', ip: remoteip || '' },
    });

    if (TURNSTILE_BYPASS) {
        t('captcha_ok')({
            submission_id: submissionId || null,
            email,
            url,
            props: { bypass: true },
        });
        res.set('X-Turnstile', 'bypass');
    } else {
        t('captcha_ok')({ submission_id: submissionId || null, email, url });
        res.set('X-Turnstile', 'ok');
    }

    console.log('[turnstile]', {
        ok: okTs,
        bypass: TURNSTILE_BYPASS,
        hasToken: !!tsToken,
        ip: remoteip,
        ua: req.headers['user-agent'],
    });

    console.log('Framer submission id:', submissionId);

    let firstName = '';
    const nameSplit = (name || '').split(' ');
    if (nameSplit.length > 1) firstName = nameSplit[0];

    const key = getIdempotencyKey(req);
    if (seen.has(key)) {
        return res.status(202).json({ ok: true, duplicate: true });
    }
    markSeen(key);

    res.set('X-Turnstile-Verified', '1');
    res.status(202).json({ ok: true, received: true });

    (async () => {
        const release = await acquire();
        const startedAt = Date.now();
        try {
            const s0 = Date.now();
            const htmlSrc = await scrapePage(url);
            t('scrape_ok')({
                submission_id: submissionId || null,
                email,
                url,
                props: { ms: Date.now() - s0 },
            });

            const s1 = Date.now();
            const auditJson = await generateAudit({ html: htmlSrc });
            t('openai_ok')({
                submission_id: submissionId || null,
                email,
                url,
                props: { ms: Date.now() - s1 },
            });

            const TEMPLATES_DIR = path.resolve(__dirname, '..', 'templates');
            const templateFile = path.join(TEMPLATES_DIR, 'audit-template.ejs');
            let html;
            try {
                const tpl = await fs.readFile(templateFile, 'utf8');
                const baseHref = `file://${TEMPLATES_DIR.replace(/\\/g, '/')}/`;
                html = ejs.render(
                    tpl,
                    { audit: auditJson, url, name, baseHref },
                    { filename: templateFile }
                );
            } catch {
                html = ejs.render(fallbackTpl, { audit: auditJson, url, name });
            }

            const s2 = Date.now();
            const pdfPath = await renderPdfFromHtml(html, {
                baseDir: TEMPLATES_DIR,
            });
            t('pdf_ok')({
                submission_id: submissionId || null,
                email,
                url,
                props: { ms: Date.now() - s2 },
            });

            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                const classificationId = await idBySlug(
                    'classifications',
                    'lead'
                );
                const leadStatusId = await idBySlug('lead_statuses', 'new');
                const sourceId = await idBySlug('sources', 'website-form');
                const listId = await idBySlug('lists', 'hospitri-leads-audit');

                const leadId = await insertLead(client, {
                    name,
                    email,
                    phone,
                    location: null,
                    classification_id: classificationId,
                    lead_status_id: leadStatusId,
                    demo_status_id: null,
                    priority_id: null,
                    range_bucket_id: null,
                    actual_listings: null,
                    source_id: sourceId,
                    source_url: 'https://hospitri.com/audit-agent#contact',
                });

                await addLeadToList(client, leadId, listId);

                const rawScore =
                    typeof auditJson?.overall_score === 'number'
                        ? auditJson.overall_score
                        : null;
                const safeScore =
                    rawScore == null
                        ? null
                        : Math.round(Math.max(0, Math.min(10, rawScore)) * 10) /
                          10;

                await insertAudit(client, {
                    lead_id: leadId,
                    listing_url: url,
                    listing_title: auditJson?.listing_title || null,
                    overall_score: safeScore,
                    submission_id: submissionId || null,
                });

                await client.query('COMMIT');
                t('db_ok')({
                    submission_id: submissionId || null,
                    email,
                    url,
                    lead_id: leadId,
                });
            } catch (dbErr) {
                await client.query('ROLLBACK');
                t('db_err')({
                    submission_id: submissionId || null,
                    email,
                    url,
                    props: { error: dbErr?.message },
                });
                console.error('DB transaction failed:', dbErr);
            } finally {
                client.release();
            }

            try {
                const recordId = await upsertPerson({ name, email, phone });
                if (recordId) await addToAuditList(recordId);
                t('attio_ok')({
                    submission_id: submissionId || null,
                    email,
                    url,
                });
                console.log('[attio] synced', { email });
            } catch (attioErr) {
                t('attio_err')({
                    submission_id: submissionId || null,
                    email,
                    url,
                    props: {
                        error: attioErr?.response?.data || attioErr?.message,
                    },
                });
                console.error(
                    '[attio] sync failed',
                    attioErr?.response?.data || attioErr
                );
            }

            await sendEmailWithAttachment({
                to: email,
                templateId:
                    process.env.MAILERSEND_TEMPLATE_AUDIT || 'zr6ke4ned7e4on12',
                variables: { name: firstName },
                attachmentPath: pdfPath,
            });
            t('email_ok')({
                submission_id: submissionId || null,
                email,
                url,
                props: { total_ms: Date.now() - startedAt },
            });

            console.log('Audit sent OK', { email, url });
        } catch (err) {
            t('pipeline_err')({
                submission_id: submissionId || null,
                email,
                url,
                props: { error: err?.message },
            });
            console.error('Background processing failed:', err);
        } finally {
            release();
        }
    })();
});

module.exports = router;
