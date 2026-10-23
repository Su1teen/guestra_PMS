-- Additive: per-night supplements above the room type default occupancy (NULL keeps per-room pricing),
-- and soft deactivation of company / group profiles.
ALTER TABLE rate_plans ADD COLUMN IF NOT EXISTS extra_adult_amount numeric(12,2);
ALTER TABLE rate_plans ADD COLUMN IF NOT EXISTS extra_child_amount numeric(12,2);
ALTER TABLE group_profiles ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
