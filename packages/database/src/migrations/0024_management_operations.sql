-- Management cockpit, Guest 360 merge lineage, unified operational tasks,
-- and maintenance work orders. Additive only; existing request rows remain valid.

ALTER TYPE service_request_status ADD VALUE IF NOT EXISTS 'assigned';
ALTER TYPE service_request_status ADD VALUE IF NOT EXISTS 'completed';

ALTER TYPE service_request_type ADD VALUE IF NOT EXISTS 'late_checkout';
ALTER TYPE service_request_type ADD VALUE IF NOT EXISTS 'early_checkin';
ALTER TYPE service_request_type ADD VALUE IF NOT EXISTS 'extra_towel';
ALTER TYPE service_request_type ADD VALUE IF NOT EXISTS 'extra_blanket';
ALTER TYPE service_request_type ADD VALUE IF NOT EXISTS 'housekeeping';
ALTER TYPE service_request_type ADD VALUE IF NOT EXISTS 'spa_booking';
ALTER TYPE service_request_type ADD VALUE IF NOT EXISTS 'restaurant_request';
ALTER TYPE service_request_type ADD VALUE IF NOT EXISTS 'transfer';
ALTER TYPE service_request_type ADD VALUE IF NOT EXISTS 'breakfast';
ALTER TYPE service_request_type ADD VALUE IF NOT EXISTS 'technical_problem';
ALTER TYPE service_request_type ADD VALUE IF NOT EXISTS 'other';

ALTER TABLE guests ADD COLUMN IF NOT EXISTS merged_into_guest_id uuid REFERENCES guests(id);
ALTER TABLE guests ADD COLUMN IF NOT EXISTS merged_at timestamptz;

ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS guest_id uuid REFERENCES guests(id);
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS category varchar(80);
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS department varchar(80);
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS assignee_id uuid REFERENCES users(id);
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS due_at timestamptz;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS started_at timestamptz;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS sla_deadline timestamptz;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS comments jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id);
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS completed_by uuid REFERENCES users(id);
CREATE INDEX IF NOT EXISTS service_requests_property_sla_idx
  ON service_requests(property_id, sla_deadline);
CREATE INDEX IF NOT EXISTS service_requests_property_assignee_idx
  ON service_requests(property_id, assignee_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'maintenance_category') THEN
    CREATE TYPE maintenance_category AS ENUM
      ('hvac','plumbing','electrical','furniture','appliance','internet','lighting','bathroom','safety','other');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'maintenance_priority') THEN
    CREATE TYPE maintenance_priority AS ENUM ('low','normal','high','critical');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'maintenance_status') THEN
    CREATE TYPE maintenance_status AS ENUM
      ('open','assigned','in_progress','waiting_parts','resolved','closed','cancelled');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS maintenance_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  room_id uuid REFERENCES rooms(id),
  reservation_id uuid REFERENCES reservations(id),
  guest_id uuid REFERENCES guests(id),
  category maintenance_category NOT NULL DEFAULT 'other',
  title varchar(255) NOT NULL,
  description text NOT NULL,
  priority maintenance_priority NOT NULL DEFAULT 'normal',
  status maintenance_status NOT NULL DEFAULT 'open',
  department varchar(80) NOT NULL DEFAULT 'maintenance',
  assignee_id uuid REFERENCES users(id),
  reported_by uuid REFERENCES users(id),
  started_at timestamptz,
  completed_at timestamptz,
  sla_deadline timestamptz,
  resolution text,
  comments jsonb NOT NULL DEFAULT '[]'::jsonb,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  blocks_inventory boolean NOT NULL DEFAULT false,
  return_to_service_required boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS maintenance_tickets_property_status_idx
  ON maintenance_tickets(property_id, status);
CREATE INDEX IF NOT EXISTS maintenance_tickets_property_room_idx
  ON maintenance_tickets(property_id, room_id);
CREATE INDEX IF NOT EXISTS maintenance_tickets_property_sla_idx
  ON maintenance_tickets(property_id, sla_deadline);

ALTER TABLE rate_restrictions ADD COLUMN IF NOT EXISTS override_reason text;
ALTER TABLE rate_restrictions ADD COLUMN IF NOT EXISTS override_by uuid;
UPDATE rate_restrictions
SET override_reason = 'Legacy override (reason unavailable)'
WHERE rate_override IS NOT NULL AND nullif(btrim(override_reason), '') IS NULL;
ALTER TABLE rate_restrictions
  DROP CONSTRAINT IF EXISTS rate_restrictions_override_reason_check;
ALTER TABLE rate_restrictions
  ADD CONSTRAINT rate_restrictions_override_reason_check
  CHECK (rate_override IS NULL OR nullif(btrim(override_reason), '') IS NOT NULL);
