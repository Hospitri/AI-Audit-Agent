const express = require('express');
const router = express.Router();
const path = require('path');
const ejs = require('ejs');
const { scrapePage } = require('../utils/scrape');
const { generateAudit } = require('../utils/openai-client');
const { renderPdfFromHtml } = require('../utils/pdf');
const { sendEmailWithAttachment } = require('../utils/mailer');

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

router.post('/', async (req, res) => {
    try {
        const { name, email, phone, url } = req.body;

        if (!url || !email || !name)
            return res
                .status(400)
                .json({ error: 'name, email and url required' });
        if (!isValidEmail(email))
            return res.status(400).json({ error: 'invalid email format' });
        if (!isValidUrl(url))
            return res
                .status(400)
                .json({ error: 'invalid or unsupported URL' });

        const html = await scrapePage(url);
        const auditJson = await generateAudit({ html });

        const templatePath = path.resolve(
            __dirname,
            '..',
            'templates',
            'audit-template.ejs'
        );
        const str = await ejs.renderFile(templatePath, {
            audit: auditJson,
            url,
            name,
        });

        const pdfPath = await renderPdfFromHtml(str);

        // await sendEmailWithAttachment({
        //     to: email,
        //     subject: `Hospitri — Audit for ${url}`,
        //     text: `<p>Hi ${name},</p><p>Attached is your audit for <b>${url}</b>.</p>`,
        //     attachmentPath: pdfPath,
        // });

        res.json({
            ok: true,
            pdfPath,
            auditJson,
        });
    } catch (err) {
        console.error('Error in /api/audit:', err);
        res.status(500).json({ error: 'internal error', details: err.message });
    }
});

module.exports = router;
