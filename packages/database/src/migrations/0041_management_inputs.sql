CREATE TABLE IF NOT EXISTS management_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES properties(id),
  start_date date NOT NULL, end_date date NOT NULL, kind varchar(16) NOT NULL CHECK (kind IN ('budget','expenses')),
  revision integer NOT NULL CHECK (revision > 0), currency_code varchar(3) NOT NULL,
  entries jsonb NOT NULL CHECK (jsonb_typeof(entries) = 'array'), coverage_through date,
  reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date), CHECK (coverage_through IS NULL OR coverage_through BETWEEN start_date AND end_date)
);
CREATE UNIQUE INDEX IF NOT EXISTS management_inputs_version_unique ON management_inputs(property_id,start_date,end_date,kind,revision);
