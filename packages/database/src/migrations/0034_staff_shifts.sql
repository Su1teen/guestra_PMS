CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE TABLE IF NOT EXISTS staff_shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id), user_id uuid NOT NULL REFERENCES users(id),
  start_at timestamptz NOT NULL, end_at timestamptz NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','confirmed','cancelled')),
  breaks jsonb NOT NULL DEFAULT '[]'::jsonb, max_open_tasks integer CHECK (max_open_tasks > 0), notes text,
  revision integer NOT NULL DEFAULT 1, idempotency_key varchar(200) NOT NULL, request_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at AND end_at <= start_at + interval '25 hours'),
  CONSTRAINT staff_shifts_user_interval_excl EXCLUDE USING gist (user_id WITH =, tstzrange(start_at,end_at,'[)') WITH &&) WHERE (status <> 'cancelled')
);
CREATE INDEX IF NOT EXISTS staff_shifts_property_time_idx ON staff_shifts(property_id,start_at,end_at);
CREATE UNIQUE INDEX IF NOT EXISTS staff_shifts_property_request_unique ON staff_shifts(property_id,idempotency_key);
ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;
INSERT INTO role_permissions(property_id,role_id,permission_key)
SELECT DISTINCT rp.property_id, rp.role_id, 'housekeeping.execute'
FROM role_permissions rp JOIN roles r ON r.id=rp.role_id
WHERE rp.permission_key='housekeeping.read' AND r.is_system AND r.key IN ('admin','general_manager','housekeeping','housekeeping_manager')
ON CONFLICT DO NOTHING;
