const axios = require('axios');
const crypto = require('crypto');

function sha256HexNorm(value) {
    if (!value && value !== '') return null;
    const s = String(value || '')
        .trim()
        .toLowerCase();
    return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

async function sendConversionEvent({
    pixelId,
    accessToken,
    eventName = 'SubmitForm',
    eventTime = Math.floor(Date.now() / 1000),
    userData = {},
    customData = {},
    eventId = null,
    testEventCode = null,
    apiVersion = 'v21.0',
}) {
    if (!pixelId || !accessToken) {
        throw new Error('FB pixelId/accessToken required');
    }

    const endpoint = `https://graph.facebook.com/${apiVersion}/${pixelId}/events${
        testEventCode
            ? `?test_event_code=${encodeURIComponent(testEventCode)}`
            : ''
    }`;
    const body = {
        data: [
            {
                event_name: eventName,
                event_time: eventTime,
                action_source: 'website',
                user_data: userData,
                custom_data: customData,
            },
        ],
    };
    if (eventId) body.data[0].event_id = eventId;
    try {
        const resp = await axios.post(endpoint, body, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
            timeout: 10000,
        });
        return resp.data;
    } catch (err) {
        const msg = err?.response?.data || err.message || String(err);
        const e = new Error('FB CAPI error: ' + JSON.stringify(msg));
        e.raw = msg;
        throw e;
    }
}

module.exports = { sha256HexNorm, sendConversionEvent };
