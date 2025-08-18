const { pool } = require('./db');

async function idBySlug(table, slug) {
    const { rows } = await pool.query(
        `SELECT id FROM ${table} WHERE slug = $1`,
        [slug]
    );
    if (!rows[0])
        throw new Error(`Missing seed in ${table} for slug="${slug}"`);
    return rows[0].id;
}

module.exports = { idBySlug };
