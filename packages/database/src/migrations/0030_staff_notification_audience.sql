-- Additive: existing custom notifications retain their audience and read state.
ALTER TABLE staff_notifications ADD COLUMN IF NOT EXISTS deduplication_key varchar(200);
ALTER TABLE staff_notifications ADD COLUMN IF NOT EXISTS required_permission varchar(100);
CREATE UNIQUE INDEX IF NOT EXISTS staff_notifications_property_dedup_unique ON staff_notifications (property_id, deduplication_key);
