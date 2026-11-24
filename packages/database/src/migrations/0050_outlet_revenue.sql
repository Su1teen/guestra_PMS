-- Additive. Outlet (point of sale) revenue for the management report: two departments that had
-- no charge type of their own (bath, entertainment) and the outlet name on a charge, so revenue can
-- be shown per department and per outlet. Existing rows keep outlet NULL and their type.
ALTER TYPE charge_type ADD VALUE IF NOT EXISTS 'bath';
ALTER TYPE charge_type ADD VALUE IF NOT EXISTS 'entertainment';
ALTER TABLE charges ADD COLUMN IF NOT EXISTS outlet varchar(80);
CREATE INDEX IF NOT EXISTS charges_property_service_date_idx ON charges (property_id, service_date);
