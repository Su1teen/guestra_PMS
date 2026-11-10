-- Additive: tentative (option) bookings with a guarantee, the confirmation trail, and child ages.
-- NULL everywhere keeps current behaviour: existing rows stay as they are, no backfill required.
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS child_ages smallint[];
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS option_until timestamptz;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS guarantee_type varchar(20);
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS required_deposit numeric(12,2);
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS confirmed_by uuid;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS confirmation_sent_at timestamptz;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS proposal_sent_at timestamptz;
-- Option sweep reads only open tentative bookings.
CREATE INDEX IF NOT EXISTS reservations_pending_option_idx
  ON reservations (property_id, option_until) WHERE status = 'pending' AND option_until IS NOT NULL;
-- Child supplements by age band: { "<bandCode>": ["<1st child>", "<2nd child>", ...] } per night.
ALTER TABLE rate_plans ADD COLUMN IF NOT EXISTS child_supplements jsonb;
