-- Additive Guestra CRM / PMS integration model. Existing operational rows remain untouched.
ALTER TABLE room_types ADD COLUMN IF NOT EXISTS max_adults integer;
ALTER TABLE room_types ADD COLUMN IF NOT EXISTS max_children integer;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS integration_context jsonb;

DO $$ BEGIN
  CREATE TYPE service_agent_booking_mode AS ENUM ('live_booking', 'request_only', 'info_only', 'disabled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE service_booking_status AS ENUM ('scheduled', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE services ADD COLUMN IF NOT EXISTS agent_booking_mode service_agent_booking_mode NOT NULL DEFAULT 'disabled';
ALTER TABLE services ADD COLUMN IF NOT EXISTS duration_minutes integer;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS source_channel varchar(40) NOT NULL DEFAULT 'front_desk';
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS idempotency_key varchar(200);
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS integration_context jsonb;

CREATE TABLE IF NOT EXISTS guest_property_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id uuid NOT NULL REFERENCES guests(id),
  property_id uuid NOT NULL REFERENCES properties(id),
  relationship varchar(40) NOT NULL DEFAULT 'guest',
  source varchar(40) NOT NULL DEFAULT 'pms',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS guest_property_links_guest_property_unique ON guest_property_links(guest_id, property_id);
CREATE INDEX IF NOT EXISTS guest_property_links_property_idx ON guest_property_links(property_id);

CREATE TABLE IF NOT EXISTS integration_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  source_system varchar(60) NOT NULL,
  external_entity_type varchar(80) NOT NULL,
  external_entity_id varchar(200) NOT NULL,
  local_entity_type varchar(80) NOT NULL,
  local_entity_id uuid NOT NULL,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS integration_links_external_unique ON integration_links(property_id, source_system, external_entity_type, external_entity_id);
CREATE INDEX IF NOT EXISTS integration_links_local_idx ON integration_links(property_id, source_system, local_entity_type, local_entity_id);
CREATE INDEX IF NOT EXISTS integration_links_property_local_idx ON integration_links(property_id, local_entity_type, local_entity_id);

CREATE TABLE IF NOT EXISTS service_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  guest_id uuid NOT NULL REFERENCES guests(id),
  service_id uuid NOT NULL REFERENCES services(id),
  reservation_id uuid REFERENCES reservations(id),
  folio_id uuid REFERENCES folios(id),
  status service_booking_status NOT NULL DEFAULT 'scheduled',
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  participants integer NOT NULL DEFAULT 1,
  quantity integer NOT NULL DEFAULT 1,
  unit_price numeric(12,2) NOT NULL,
  total_amount numeric(12,2) NOT NULL,
  currency_code varchar(3) NOT NULL,
  notes text,
  source_channel varchar(40) NOT NULL DEFAULT 'front_desk',
  idempotency_key varchar(200),
  integration_context jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS service_bookings_property_idempotency_unique ON service_bookings(property_id, idempotency_key);
CREATE INDEX IF NOT EXISTS service_bookings_property_service_time_idx ON service_bookings(property_id, service_id, start_at);
CREATE INDEX IF NOT EXISTS service_bookings_guest_idx ON service_bookings(property_id, guest_id);

CREATE TABLE IF NOT EXISTS service_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  service_id uuid NOT NULL REFERENCES services(id),
  code varchar(60) NOT NULL,
  name varchar(120) NOT NULL,
  capacity integer NOT NULL DEFAULT 1,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS service_resources_service_idx ON service_resources(property_id, service_id);

CREATE TABLE IF NOT EXISTS service_resource_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  service_booking_id uuid NOT NULL REFERENCES service_bookings(id),
  resource_id uuid NOT NULL REFERENCES service_resources(id),
  units integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS service_resource_allocations_booking_resource_unique ON service_resource_allocations(service_booking_id, resource_id);
CREATE INDEX IF NOT EXISTS service_resource_allocations_resource_idx ON service_resource_allocations(property_id, resource_id);
CREATE UNIQUE INDEX IF NOT EXISTS service_requests_property_idempotency_unique ON service_requests(property_id, idempotency_key);
