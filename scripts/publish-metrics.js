require('dotenv').config();
const { pool } = require('../utils/db');
const { upsertDailyMetrics } = require('../utils/notion');

async function main() {
    const {
        rows: [funnel],
    } = await pool.query(`
    SELECT
      (now() at time zone 'UTC')::date AS day,
      COALESCE((SELECT SUM(cnt) FROM (
        SELECT COUNT(*) AS cnt FROM events WHERE date_trunc('day', created_at) = (now()::date) AND event='form_received'
      ) x), 0) AS form_received,
      COALESCE((SELECT COUNT(*) FROM events WHERE date_trunc('day', created_at) = (now()::date) AND event='captcha_ok'), 0) AS captcha_ok,
      COALESCE((SELECT COUNT(*) FROM events WHERE date_trunc('day', created_at) = (now()::date) AND event='rate_limited'), 0) AS rate_limited,
      COALESCE((SELECT COUNT(*) FROM events WHERE date_trunc('day', created_at) = (now()::date) AND event='scrape_ok'), 0) AS scrape_ok,
      COALESCE((SELECT COUNT(*) FROM events WHERE date_trunc('day', created_at) = (now()::date) AND event='openai_ok'), 0) AS openai_ok,
      COALESCE((SELECT COUNT(*) FROM events WHERE date_trunc('day', created_at) = (now()::date) AND event='pdf_ok'), 0) AS pdf_ok,
      COALESCE((SELECT COUNT(*) FROM events WHERE date_trunc('day', created_at) = (now()::date) AND event='db_ok'), 0) AS db_ok,
      COALESCE((SELECT COUNT(*) FROM events WHERE date_trunc('day', created_at) = (now()::date) AND event='email_ok'), 0) AS email_ok
  `);

    const {
        rows: [leads],
    } = await pool.query(
        `SELECT COALESCE(COUNT(*),0) AS new_leads FROM v_new_leads_daily WHERE day = date_trunc('day', now())`
    );
    const {
        rows: [aud],
    } = await pool.query(
        `SELECT COALESCE(audits,0) AS audits, COALESCE(avg_score,0) AS avg_score, COALESCE(p50,0) AS p50_score, COALESCE(p95,0) AS p95_score FROM v_audits_daily WHERE day = date_trunc('day', now())`
    );

    const { rows: mixRows } = await pool.query(`
    SELECT platform, COALESCE(SUM(scrapes),0) AS c
    FROM v_platform_mix
    WHERE day = date_trunc('day', now())
    GROUP BY platform
  `);
    const mix = Object.fromEntries(mixRows.map(r => [r.platform, Number(r.c)]));

    const metrics = {
        form_received: Number(funnel?.form_received || 0),
        captcha_ok: Number(funnel?.captcha_ok || 0),
        rate_limited: Number(funnel?.rate_limited || 0),
        scrape_ok: Number(funnel?.scrape_ok || 0),
        openai_ok: Number(funnel?.openai_ok || 0),
        pdf_ok: Number(funnel?.pdf_ok || 0),
        db_ok: Number(funnel?.db_ok || 0),
        email_ok: Number(funnel?.email_ok || 0),
        new_leads: Number(leads?.new_leads || 0),
        audits: Number(aud?.audits || 0),
        avg_score: Number(aud?.avg_score || 0),
        p50_score: Number(aud?.p50_score || 0),
        p95_score: Number(aud?.p95_score || 0),
        airbnb: Number(mix.airbnb || 0),
        booking: Number(mix.booking || 0),
        vrbo: Number(mix.vrbo || 0),
    };

    const todayISO = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
    const res = await upsertDailyMetrics({ dateISO: todayISO, metrics });
    console.log('[notion] upsert', res);

    await pool.end();
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
