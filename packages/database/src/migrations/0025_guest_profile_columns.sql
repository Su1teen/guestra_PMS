-- Keep upgraded databases aligned with the current guest-profile schema.
-- CREATE TABLE IF NOT EXISTS does not add columns to an existing table, so
-- older demo databases need explicit, idempotent additions.
ALTER TABLE guests ADD COLUMN IF NOT EXISTS id_type varchar(30);
ALTER TABLE guests ADD COLUMN IF NOT EXISTS id_number varchar(50);
ALTER TABLE guests ADD COLUMN IF NOT EXISTS id_country varchar(2);
ALTER TABLE guests ADD COLUMN IF NOT EXISTS id_expiry timestamptz;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS nationality varchar(2);
ALTER TABLE guests ADD COLUMN IF NOT EXISTS date_of_birth date;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS gender varchar(20);
ALTER TABLE guests ADD COLUMN IF NOT EXISTS profession varchar(100);
ALTER TABLE guests ADD COLUMN IF NOT EXISTS tax_id varchar(50);
ALTER TABLE guests ADD COLUMN IF NOT EXISTS registration_data jsonb;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS address_line_1 varchar(255);
ALTER TABLE guests ADD COLUMN IF NOT EXISTS address_line_2 varchar(255);
ALTER TABLE guests ADD COLUMN IF NOT EXISTS city varchar(100);
ALTER TABLE guests ADD COLUMN IF NOT EXISTS state_province varchar(100);
ALTER TABLE guests ADD COLUMN IF NOT EXISTS postal_code varchar(20);
ALTER TABLE guests ADD COLUMN IF NOT EXISTS country_code varchar(2);
ALTER TABLE guests ADD COLUMN IF NOT EXISTS company_name varchar(255);
ALTER TABLE guests ADD COLUMN IF NOT EXISTS loyalty_number varchar(50);
ALTER TABLE guests ADD COLUMN IF NOT EXISTS preferences jsonb;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS is_dnr boolean NOT NULL DEFAULT false;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS dnr_reason text;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS dnr_date timestamptz;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS gdpr_consent_marketing boolean NOT NULL DEFAULT false;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS gdpr_consent_date timestamptz;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS gdpr_data_retention_override timestamptz;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS is_deleted boolean NOT NULL DEFAULT false;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS merged_into_guest_id uuid REFERENCES guests(id);
ALTER TABLE guests ADD COLUMN IF NOT EXISTS merged_at timestamptz;
