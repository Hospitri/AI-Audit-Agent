const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

function htmlToText(html) {
    if (!html) return '';
    return html
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function sendEmailWithAttachment({
    to,
    subject,
    html,
    text,
    attachmentPath,
}) {
    const apiKey = process.env.MAILERSEND_API_KEY;
    const fromEmail = process.env.MAILERSEND_FROM;

    if (!apiKey) throw new Error('MAILERSEND_API_KEY missing');
    if (!fromEmail) throw new Error('MAILERSEND_FROM missing');

    let attachments = [];
    if (attachmentPath) {
        const fileBuffer = await fs.readFile(attachmentPath);
        const base64 = fileBuffer.toString('base64');
        const filename = path.basename(attachmentPath);
        attachments.push({ content: base64, filename });
    }

    const payload = {
        from: { email: fromEmail },
        to: [{ email: to }],
        subject,
        html: html || undefined,
        text: text ?? htmlToText(html || ''),
        attachments: attachments.length ? attachments : undefined,
    };

    await axios.post('https://api.mailersend.com/v1/email', payload, {
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        timeout: 20000,
    });
}

module.exports = { sendEmailWithAttachment };
