const express = require('express');
const router = express.Router();
const { scrapePage } = require('../utils/scrape');
const { generateAudit } = require('../utils/openai-client');
const { renderPdfFromHtml } = require('../utils/pdf');
const { sendEmailWithAttachment } = require('../utils/mailer');

router.post('/', async (req, res) => {
    try {
        const { name, email, phone, url } = req.body;
        //TODO Validate URL regex + host whitelist

        if (!url || !email || !name)
            return res
                .status(400)
                .json({ error: 'name, email and url required' });

        const html = await scrapePage(url);
        const auditJson = await generateAudit({ html });

        const str = await require('ejs').renderFile(
            `${__dirname}/../templates/audit-template.ejs`,
            { audit: auditJson, url, name }
        );
        const pdfPath = await renderPdfFromHtml(str);

        await sendEmailWithAttachment({
            to: email,
            subject: `Hospitri — Audit for ${url}`,
            text: `Hi ${name}, attached is your audit for ${url}`,
            attachmentPath: pdfPath,
        });

        res.json({
            auditJson,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'internal error', details: err.message });
    }
});

module.exports = router;
