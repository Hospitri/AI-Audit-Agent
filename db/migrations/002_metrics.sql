CREATE TABLE IF NOT EXISTS events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  event         text        NOT NULL,     
  submission_id text,                     
  lead_id       uuid REFERENCES leads(id) ON DELETE SET NULL,
  email         citext,
  url           text,
  props         jsonb                      
);
CREATE INDEX IF NOT EXISTS events_created_idx ON events(created_at);
CREATE INDEX IF NOT EXISTS events_event_idx   ON events(event);
CREATE INDEX IF NOT EXISTS events_subm_idx    ON events(submission_id);

CREATE OR REPLACE FUNCTION platform_of(url text) RETURNS text AS $$
  SELECT CASE
    WHEN url ILIKE '%airbnb.%'  THEN 'airbnb'
    WHEN url ILIKE '%booking.%' THEN 'booking'
    WHEN url ILIKE '%vrbo.%'    THEN 'vrbo'
    ELSE 'other'
  END;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE VIEW v_daily_funnel AS
SELECT
  date_trunc('day', created_at) AS day,
  COUNT(*) FILTER (WHERE event = 'form_received')   AS form_received,
  COUNT(*) FILTER (WHERE event = 'captcha_ok')      AS captcha_ok,
  COUNT(*) FILTER (WHERE event = 'rate_limited')    AS rate_limited,
  COUNT(*) FILTER (WHERE event = 'scrape_ok')       AS scrape_ok,
  COUNT(*) FILTER (WHERE event = 'openai_ok')       AS openai_ok,
  COUNT(*) FILTER (WHERE event = 'pdf_ok')          AS pdf_ok,
  COUNT(*) FILTER (WHERE event = 'db_ok')           AS db_ok,
  COUNT(*) FILTER (WHERE event = 'email_ok')        AS email_ok,
  COUNT(*) FILTER (WHERE event = 'attio_ok')        AS attio_ok
FROM events
GROUP BY 1
ORDER BY 1 DESC;

CREATE OR REPLACE VIEW v_platform_mix AS
SELECT
  date_trunc('day', e.created_at) AS day,
  platform_of(e.url)              AS platform,
  COUNT(*)                        AS scrapes
FROM events e
WHERE e.event = 'scrape_ok'
GROUP BY 1, 2
ORDER BY 1 DESC, 2;

CREATE OR REPLACE VIEW v_audits_daily AS
SELECT
  date_trunc('day', created_at) AS day,
  COUNT(*)                      AS audits,
  AVG(overall_score)            AS avg_score,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY overall_score) AS p50,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY overall_score) AS p95
FROM audits
GROUP BY 1
ORDER BY 1 DESC;

CREATE OR REPLACE VIEW v_new_leads_daily AS
SELECT
  date_trunc('day', created_at) AS day,
  COUNT(*)                      AS new_leads
FROM leads
WHERE source_url = 'https://hospitri.com/ai-audit'
GROUP BY 1
ORDER BY 1 DESC;

CREATE OR REPLACE VIEW v_scores_by_platform AS
SELECT
  date_trunc('day', a.created_at) AS day,
  platform_of(e.url)              AS platform,
  COUNT(*)                        AS audits,
  AVG(a.overall_score)            AS avg_score
FROM audits a
LEFT JOIN events e
  ON e.submission_id = a.submission_id
  AND e.event = 'scrape_ok'
GROUP BY 1, 2
ORDER BY 1 DESC, 2;
