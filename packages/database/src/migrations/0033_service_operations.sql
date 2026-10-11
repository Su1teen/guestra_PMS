-- Preserve existing catalog, booking, allocation and financial facts.
ALTER TABLE services ADD COLUMN IF NOT EXISTS tax_mode varchar(20);
ALTER TABLE service_bookings ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
ALTER TABLE service_bookings ADD COLUMN IF NOT EXISTS pricing_snapshot jsonb;
ALTER TABLE service_resources ADD COLUMN IF NOT EXISTS buffer_before_minutes integer NOT NULL DEFAULT 0;
ALTER TABLE service_resources ADD COLUMN IF NOT EXISTS buffer_after_minutes integer NOT NULL DEFAULT 0;
ALTER TABLE service_resources ADD COLUMN IF NOT EXISTS schedule jsonb;
ALTER TABLE service_resource_allocations ADD COLUMN IF NOT EXISTS start_at timestamptz;
ALTER TABLE service_resource_allocations ADD COLUMN IF NOT EXISTS end_at timestamptz;
CREATE TABLE IF NOT EXISTS service_resource_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  resource_id uuid NOT NULL REFERENCES service_resources(id),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at)
);
CREATE INDEX IF NOT EXISTS service_resource_blocks_property_resource_time_idx
  ON service_resource_blocks(property_id, resource_id, start_at);
CREATE TABLE IF NOT EXISTS service_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  idempotency_key varchar(200) NOT NULL,
  fingerprint text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS service_operations_property_key_unique
  ON service_operations(property_id, idempotency_key);
