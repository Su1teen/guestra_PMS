ALTER TABLE maintenance_tickets ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS room_inventory_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id), room_id uuid NOT NULL REFERENCES rooms(id),
  maintenance_ticket_id uuid REFERENCES maintenance_tickets(id),
  start_date date NOT NULL, end_date date NOT NULL,
  kind varchar(3) NOT NULL CHECK (kind IN ('OOO','OOS')),
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','cancelled')),
  reason text NOT NULL, revision integer NOT NULL DEFAULT 1,
  released_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date > start_date)
);
CREATE INDEX IF NOT EXISTS room_inventory_blocks_property_room_date_idx ON room_inventory_blocks(property_id,room_id,start_date,end_date);
