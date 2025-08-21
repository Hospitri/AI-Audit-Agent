const { pool } = require('./db');

async function track(
    event,
    {
        submission_id = null,
        lead_id = null,
        email = null,
        url = null,
        props = null,
    } = {}
) {
    try {
        await pool.query(
            `INSERT INTO events(event, submission_id, lead_id, email, url, props)
       VALUES ($1,$2,$3,$4,$5,$6)`,
            [
                event,
                submission_id,
                lead_id,
                email,
                url,
                props ? JSON.stringify(props) : null,
            ]
        );
    } catch (err) {
        console.warn('[metrics.track] failed', event, err?.message);
    }
}

const t = event => meta => track(event, meta);

module.exports = {
    track,
    t,
};
