const axios = require('axios');

const ATTIO_BASE = process.env.ATTIO_BASE_URL || 'https://api.attio.com';
const H = () => ({
    Authorization: `Bearer ${process.env.ATTIO_API_KEY}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'Hospitri-Audit-Agent/1.0',
});

function formatNameForAttio(name) {
    if (!name || typeof name !== 'string') return '';
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
        const first = parts[0];
        const last = parts[parts.length - 1];
        return `${last}, ${first}`;
    }
    return name.trim();
}

async function attioPut(url, data, params) {
    const max = 3;
    let lastErr;
    for (let i = 0; i < max; i++) {
        try {
            return await axios.put(url, data, {
                params,
                headers: H(),
                timeout: 10000,
            });
        } catch (err) {
            const status = err?.response?.status;
            if (status === 429 || (status >= 500 && status <= 599)) {
                await new Promise(r => setTimeout(r, 500 * (i + 1)));
                lastErr = err;
                continue;
            }
            throw err;
        }
    }
    throw lastErr;
}

async function upsertPerson({ name, email, phone, listing_url }) {
    if (!process.env.ATTIO_API_KEY) {
        console.warn('[attio] missing ATTIO_API_KEY; skipping');
        return null;
    }
    if (!email) return null;

    const payload = {
        data: {
            values: {
                name: formatNameForAttio(name || ''),
                classification: [process.env.ATTIO_CLASSIFICATION_LEAD_ID],
                email_addresses: [String(email).toLowerCase()],
                source: process.env.ATTIO_SOURCE_WEBSITE_FORM_ID,
                source_url: 'https://hospitri.com/ai-audit',
                ...(phone ? { phone_numbers: [phone] } : {}),
                ...(listing_url ? { listing_url: String(listing_url) } : {}),
            },
        },
    };

    const url = `${ATTIO_BASE}/v2/objects/people/records`;
    const params = { matching_attribute: 'email_addresses' };

    const resp = await attioPut(url, payload, params);
    const recordId = resp?.data?.data?.id?.record_id || null;
    const webUrl = resp?.data?.data?.web_url || null;

    if (!recordId) {
        console.warn('[attio] upsert ok but no record_id found', resp?.data);
    }
    if (!webUrl) {
        console.warn('[attio] upsert ok but no webUrl found', resp?.data);
    }
    return { recordId, webUrl };
}

async function addToAuditList(recordId) {
    if (!process.env.ATTIO_API_KEY) return;
    if (!recordId) return;

    const payload = {
        data: {
            parent_record_id: recordId,
            parent_object: 'people',
            entry_values: {
                lead_status: [process.env.ATTIO_LEAD_STATUS_NEW_ID],
            },
        },
    };

    const url = `${ATTIO_BASE}/v2/lists/${process.env.ATTIO_AUDIT_LIST_ID}/entries`;
    await attioPut(url, payload);
}

module.exports = { upsertPerson, addToAuditList, formatNameForAttio };
