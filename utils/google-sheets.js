const fetch = require('node-fetch');
async function appendRowViaAppsScript({ name, email, phone, url }) {
    const ENDPOINT = process.env.GAS_ENDPOINT_URL;
    const SECRET = process.env.GAS_SECRET;

    const body = { token: SECRET, name, email, phone, url };
    const resp = await fetch(ENDPOINT, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
    });
    const j = await resp.json();
    if (!j.ok) throw new Error('GAS append failed: ' + JSON.stringify(j));
}
module.exports = { appendRowViaAppsScript };
