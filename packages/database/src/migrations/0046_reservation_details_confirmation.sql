-- Additive: the guest confirmed the booking details sent to them (in a chat, or recorded by staff).
-- NULL keeps current behaviour for every existing row.
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS details_confirmed_at timestamptz;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS details_confirmed_by varchar(120);
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS details_confirmation_ref varchar(120);
