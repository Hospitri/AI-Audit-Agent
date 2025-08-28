const { fetch } = require('undici');

function safe(str) {
    if (!str) return '—';
    return String(str).trim();
}

async function sendAuditSlackNotification({
    channel = process.env.SLACK_AUDIT_CHANNEL,
    token = process.env.SLACK_BOT_TOKEN,
    name,
    email,
    phone,
    url,
    attioUrl,
    firstName,
}) {
    if (!token || !channel) return false;

    const ts = Math.floor(Date.now() / 1000);

    const header = {
        type: 'header',
        text: {
            type: 'plain_text',
            text: '🎉 New audit lead!',
            emoji: true,
        },
    };

    const intro = {
        type: 'section',
        text: {
            type: 'mrkdwn',
            text: `It seems *${safe(
                firstName || name
            )}* generated an AI audit!`,
        },
    };

    const details = {
        type: 'section',
        text: {
            type: 'mrkdwn',
            text:
                `> *Name:* ${safe(name)}\n` +
                `> *Email:* ${safe(email)}\n` +
                `> *Phone number:* ${safe(phone)}\n` +
                `> *Listing:* <${safe(url)}|Open listing>\n` +
                `> *Created on:* <!date^${ts}^{date_num} {time}|${new Date().toISOString()}>`,
        },
    };

    const blocks = [header, intro, details, { type: 'divider' }];

    if (attioUrl) {
        const finalUrl = attioUrl.endsWith('/activity')
            ? attioUrl
            : `${attioUrl}/activity`;
        blocks.push({
            type: 'actions',
            elements: [
                {
                    type: 'button',
                    text: {
                        type: 'plain_text',
                        text: '👉 View in Attio',
                        emoji: true,
                    },
                    style: 'primary',
                    url: finalUrl,
                },
            ],
        });
    }

    const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
            channel,
            blocks,
            unfurl_links: false,
            unfurl_media: false,
        }),
    });
    const data = await res.json();

    if (!data.ok) {
        throw new Error(`Slack API error: ${data.error || 'unknown_error'}`);
    }
    return data.ts;
}

module.exports = { sendAuditSlackNotification };
