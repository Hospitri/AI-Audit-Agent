CREATE TABLE IF NOT EXISTS slack_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_ts text UNIQUE NOT NULL,
  thread_ts text,
  user_id text,
  channel_id text,
  message_text text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  processed_report_id text
);

CREATE INDEX IF NOT EXISTS idx_slack_messages_created_at ON slack_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_slack_messages_processed_id ON slack_messages(processed_report_id);