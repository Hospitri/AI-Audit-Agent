require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl:
        process.env.PGSSLMODE === 'require'
            ? { rejectUnauthorized: false }
            : undefined,
});

process.on('SIGINT', async () => {
    try {
        await pool.end();
    } finally {
        process.exit(0);
    }
});
process.on('SIGTERM', async () => {
    try {
        await pool.end();
    } finally {
        process.exit(0);
    }
});

module.exports = { pool };
