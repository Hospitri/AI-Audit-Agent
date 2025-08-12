const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');

async function sendEmailWithAttachment({ to, subject, text, attachmentPath }) {
    try {
        if (!fs.existsSync(attachmentPath)) {
            throw new Error(`Attachment not found: ${attachmentPath}`);
        }

        const form = new FormData();
        form.append('from', process.env.MAILERSEND_FROM);
        form.append('to', to);
        form.append('subject', subject);
        form.append('html', text);
        form.append('attachments[]', fs.createReadStream(attachmentPath));

        const response = await axios.post('https://api.mailersend.com/v1/email', form, {
            headers: {
                Authorization: `Bearer ${process.env.MAILERSEND_API_KEY}`,
                ...form.getHeaders(),
            },
        });

        console.log(`Email sent to ${to}, status: ${response.status}`);
    } catch (err) {
        console.error('Error sending email:', err.response?.data || err.message);
        throw new Error('Email sending failed');
    }
}

module.exports = { sendEmailWithAttachment };
