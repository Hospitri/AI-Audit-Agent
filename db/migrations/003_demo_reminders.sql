CREATE TABLE IF NOT EXISTS demo_reminders (
  booking_uid         text PRIMARY KEY,
  booking_id          bigint,
  attendee_email      text,
  attendee_name       text,
  attendee_locale     text,
  attendee_tz         text,
  start_at_utc        timestamptz,
  local_start_text    text,
  send_24h_at_utc     timestamptz,
  send_2h_at_utc      timestamptz,
  send_15m_at_utc     timestamptz,
  status              text DEFAULT 'scheduled',
  last_sent_24h_at    timestamptz,
  last_sent_2h_at     timestamptz,
  last_sent_15m_at    timestamptz,
  updated_at          timestamptz DEFAULT now()
);
