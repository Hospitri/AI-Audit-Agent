CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS classifications (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS lead_statuses (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS demo_statuses (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS priorities (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS sources (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS lists (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS listing_range_buckets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text NOT NULL UNIQUE,
  name       text NOT NULL UNIQUE,
  min_count  int  NOT NULL,
  max_count  int,
  CONSTRAINT listing_range_bounds_chk
    CHECK (max_count IS NULL OR min_count <= max_count)
);

CREATE TABLE IF NOT EXISTS leads (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at         timestamptz NOT NULL DEFAULT NOW(),
  updated_at         timestamptz NOT NULL DEFAULT NOW(),
  name               text,
  email              citext,
  phone              text,
  location           text,
  classification_id  uuid REFERENCES classifications(id) ON UPDATE CASCADE ON DELETE SET NULL,
  lead_status_id     uuid REFERENCES lead_statuses(id)   ON UPDATE CASCADE ON DELETE SET NULL,
  demo_status_id     uuid REFERENCES demo_statuses(id)   ON UPDATE CASCADE ON DELETE SET NULL,
  priority_id        uuid REFERENCES priorities(id)      ON UPDATE CASCADE ON DELETE SET NULL,
  range_bucket_id    uuid REFERENCES listing_range_buckets(id) ON UPDATE CASCADE ON DELETE SET NULL,
  actual_listings    int,
  source_id          uuid REFERENCES sources(id)         ON UPDATE CASCADE ON DELETE SET NULL,
  source_url         text,
  CONSTRAINT phone_e164_chk CHECK (
    phone IS NULL OR phone ~ '^\+[1-9][0-9]{1,14}$'
  )
);
CREATE INDEX IF NOT EXISTS leads_email_idx ON leads(email);
CREATE INDEX IF NOT EXISTS leads_created_at_idx ON leads(created_at);

CREATE TRIGGER leads_set_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS lead_list_memberships (
  lead_id   uuid NOT NULL REFERENCES leads(id) ON UPDATE CASCADE ON DELETE CASCADE,
  list_id   uuid NOT NULL REFERENCES lists(id) ON UPDATE CASCADE ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (lead_id, list_id)
);

CREATE TABLE IF NOT EXISTS audits (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     timestamptz NOT NULL DEFAULT NOW(),
  lead_id        uuid NOT NULL REFERENCES leads(id) ON UPDATE CASCADE ON DELETE CASCADE,
  listing_url    text NOT NULL,
  listing_title  text,
  overall_score  numeric(3,1),
  submission_id  text UNIQUE,
  CONSTRAINT overall_score_bounds_chk CHECK (overall_score IS NULL OR (overall_score >= 0 AND overall_score <= 10))
);
CREATE INDEX IF NOT EXISTS audits_lead_id_idx ON audits(lead_id);
CREATE INDEX IF NOT EXISTS audits_created_at_idx ON audits(created_at);

INSERT INTO classifications (slug, name) VALUES
  ('lead','Lead'),
  ('investor','Investor'),
  ('partner','Partner'),
  ('property-owner','Property owner'),
  ('property-manager','Property manager'),
  ('hospitri-user','Hospitri user')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO lead_statuses (slug, name) VALUES
  ('new','New'),
  ('follow-up','Follow up'),
  ('demo','Demo'),
  ('no-show','No Show'),
  ('contract-sent','Contract Sent'),
  ('contract-signed','Contract signed'),
  ('not-interested','Not Interested'),
  ('no-good-fit','No Good Fit')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO demo_statuses (slug, name) VALUES
  ('schedule','Schedule'),
  ('taken','Taken'),
  ('no-show','No show')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO priorities (slug, name) VALUES
  ('low','Low'),
  ('medium','Medium'),
  ('high','High'),
  ('top-notch','Top notch')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO sources (slug, name) VALUES
  ('other','Other'),
  ('referral','Referral'),
  ('networking-event','Networking Event'),
  ('website-form','Website (Form)'),
  ('facebook-form','Facebook (Form)'),
  ('direct-demo-call','Direct (Demo call)'),
  ('manual','Manual')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO lists (slug, name) VALUES
  ('hospitri-accounts','Hospitri - Accounts'),
  ('hospitri-leads','Hospitri - Leads'),
  ('hospitri-leads-audit','Hospitri - Leads (Audit)'),
  ('axial-leads','Axial - Leads')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO listing_range_buckets (slug, name, min_count, max_count) VALUES
  ('1-2','1-2',1,2),
  ('3-5','3-5',3,5),
  ('6-10','6-10',6,10),
  ('10-plus','10+',10,NULL)
ON CONFLICT (slug) DO NOTHING;
