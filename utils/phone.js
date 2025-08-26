const { parsePhoneNumberFromString } = require('libphonenumber-js');

function normalizePhoneE164(
    input,
    defaultRegion = process.env.PHONE_DEFAULT_REGION || 'US'
) {
    if (input == null) return { e164: null, valid: false };
    const raw = String(input)
        .trim()
        .replace(/[^\d+]/g, '');
    const p = raw.startsWith('+')
        ? parsePhoneNumberFromString(raw)
        : parsePhoneNumberFromString(raw, defaultRegion);
    if (p && p.isValid()) return { e164: p.number, valid: true };
    return { e164: null, valid: false };
}

module.exports = { normalizePhoneE164 };
