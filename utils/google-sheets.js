async function appendRowViaAppsScript({ name, email, phone, url }) {
    const ENDPOINT = process.env.GAS_ENDPOINT_URL;
    const SECRET = process.env.GAS_SECRET || null;

    if (!ENDPOINT) {
        console.warn(
            '[GAS] GAS_ENDPOINT_URL not set — skipping append to sheet'
        );
        return { ok: false, reason: 'missing_endpoint' };
    }

    const body = { token: SECRET, name, email, phone, url };

    try {
        const resp = await fetch(ENDPOINT, {
            method: 'POST',
            body: JSON.stringify(body),
            headers: { 'Content-Type': 'application/json' },
        });

        const text = await resp.text();
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (e) {
            parsed = text;
        }

        if (!resp.ok) {
            console.warn('[GAS] append failed', resp.status, parsed);
            return { ok: false, status: resp.status, body: parsed };
        }

        return { ok: true, status: resp.status, body: parsed };
    } catch (err) {
        console.error('[GAS] append exception', err);
        return { ok: false, reason: 'exception', error: err?.message || err };
    }
}

module.exports = { appendRowViaAppsScript };
