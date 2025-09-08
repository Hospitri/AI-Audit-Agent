require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const sql = fs.readFileSync(
    path.resolve(__dirname, '../db/migrations/004_add_meeting_url.sql'),
    'utf8'
);

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl:
        process.env.PGSSLMODE === 'require'
            ? { rejectUnauthorized: false }
            : undefined,
});

(async () => {
    try {
        await pool.query(sql);
        console.log('✅ Migration applied');
    } catch (err) {
        console.error('❌ Migration failed:', err);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
