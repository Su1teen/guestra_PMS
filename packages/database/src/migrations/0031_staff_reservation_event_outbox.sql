CREATE TABLE IF NOT EXISTS domain_event_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES properties(id),
  logical_event_id varchar(200) NOT NULL, payload jsonb NOT NULL, attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS domain_event_outbox_property_event_unique ON domain_event_outbox (property_id, logical_event_id);
CREATE INDEX IF NOT EXISTS domain_event_outbox_pending_idx ON domain_event_outbox (delivered_at, available_at);
