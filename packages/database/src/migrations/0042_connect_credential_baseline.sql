-- Repair the legacy push-schema omission without replaying migrations 0001-0021.
CREATE TABLE IF NOT EXISTS connect_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  label varchar(200) NOT NULL,
  key_hash varchar(64) NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
ALTER TABLE connect_credentials ADD COLUMN IF NOT EXISTS scopes jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS connect_credentials_property_id_idx ON connect_credentials(property_id);
