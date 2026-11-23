-- Additive. Price calendar rules (season / holiday / promo), min and max price per room type,
-- guest tier and privileges, and the price type of a reservation (complimentary, barter, ...).
-- NULL / defaults keep current pricing and reservations unchanged.
CREATE TABLE IF NOT EXISTS price_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  kind varchar(20) NOT NULL,
  name varchar(120) NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  room_type_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  adjustment_type varchar(20) NOT NULL,
  value numeric(12,2) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  reason text NOT NULL,
  created_by uuid,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS price_rules_property_dates_idx ON price_rules (property_id, start_date, end_date);

ALTER TABLE room_types ADD COLUMN IF NOT EXISTS min_price numeric(12,2);
ALTER TABLE room_types ADD COLUMN IF NOT EXISTS max_price numeric(12,2);

ALTER TABLE guests ADD COLUMN IF NOT EXISTS guest_tier varchar(20) NOT NULL DEFAULT 'regular';
ALTER TABLE guests ADD COLUMN IF NOT EXISTS privileges text;

ALTER TABLE reservations ADD COLUMN IF NOT EXISTS price_type varchar(20) NOT NULL DEFAULT 'standard';
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS price_type_reason text;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS price_type_counterparty varchar(200);
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS price_type_approved_by uuid;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS price_type_set_at timestamptz;

-- New rights: setting a complimentary / barter / internal price type, and correcting a closed stay.
-- Granted to the roles that already manage rates or billing; other roles get them from an administrator.
INSERT INTO role_permissions(property_id, role_id, permission_key)
SELECT DISTINCT rp.property_id, rp.role_id, 'reservations.price_type'
FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
WHERE rp.permission_key = 'rateplans.manage' AND r.is_system AND r.key IN ('admin', 'general_manager', 'revenue_manager')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(property_id, role_id, permission_key)
SELECT DISTINCT rp.property_id, rp.role_id, 'reservations.correct_closed'
FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
WHERE rp.permission_key = 'folios.manage' AND r.is_system AND r.key IN ('admin', 'general_manager')
ON CONFLICT DO NOTHING;
