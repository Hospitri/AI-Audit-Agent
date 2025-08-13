// utils/mailer.js
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

async function sendEmailWithAttachment({
    to,
    templateId,
    variables = {},
    attachmentPath,
}) {
    const apiKey = process.env.MAILERSEND_API_KEY;
    const fromEmail = process.env.MAILERSEND_FROM;
    if (!apiKey) throw new Error('MAILERSEND_API_KEY missing');
    if (!fromEmail) throw new Error('MAILERSEND_FROM missing');

    const file = await fs.readFile(attachmentPath);
    const base64 = file.toString('base64');
    const filename = path.basename(attachmentPath);

    const payload = {
        from: { email: fromEmail },
        to: [{ email: to }],
        template_id: templateId,
        variables: [
            {
                email: to,
                substitutions: Object.entries(variables).map(([k, v]) => ({
                    var: k,
                    value: String(v ?? ''),
                })),
            },
        ],
        attachments: [{ content: base64, filename }],
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
