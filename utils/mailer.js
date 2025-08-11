const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');

async function sendEmailWithAttachment({ to, subject, text, attachmentPath }) {
    const form = new FormData();
    form.append('from', process.env.MAILERSEND_FROM);
    form.append('to', to);
    form.append('subject', subject);
    form.append('html', text);
    form.append('attachments[]', fs.createReadStream(attachmentPath));

    await axios.post('https://api.mailersend.com/v1/email', form, {
        headers: {
            Authorization: `Bearer ${process.env.MAILERSEND_API_KEY}`,
            ...form.getHeaders(),
        },
    });
}

module.exports = { sendEmailWithAttachment };
