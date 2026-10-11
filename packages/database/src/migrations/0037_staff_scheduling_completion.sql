ALTER TABLE staff_shifts ADD COLUMN IF NOT EXISTS kind varchar(20) NOT NULL DEFAULT 'shift';
ALTER TABLE staff_shifts ADD COLUMN IF NOT EXISTS absence_type varchar(20);
ALTER TABLE staff_shifts DROP CONSTRAINT IF EXISTS staff_shifts_check;
ALTER TABLE staff_shifts ADD CONSTRAINT staff_shifts_interval_check CHECK(end_at > start_at AND end_at <= start_at + CASE WHEN kind='absence' THEN interval '93 days' ELSE interval '25 hours' END);
ALTER TABLE staff_shifts ADD CONSTRAINT staff_shifts_kind_check CHECK(kind IN ('shift','absence') AND ((kind='shift' AND absence_type IS NULL) OR (kind='absence' AND absence_type IS NOT NULL AND absence_type IN ('vacation','sickness','other'))));
ALTER TABLE staff_shifts DROP CONSTRAINT staff_shifts_user_interval_excl;
ALTER TABLE staff_shifts ADD CONSTRAINT staff_shifts_user_interval_excl EXCLUDE USING gist(user_id WITH =,tstzrange(start_at,end_at,'[)') WITH &&) WHERE(status<>'cancelled' AND kind='shift');
CREATE TABLE staff_shift_templates(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES properties(id),user_id uuid NOT NULL REFERENCES users(id),
 name varchar(100) NOT NULL, weekdays jsonb NOT NULL,start_time varchar(5) NOT NULL,end_time varchar(5) NOT NULL, overnight integer NOT NULL DEFAULT 0 CHECK(overnight IN (0,1)),
 breaks jsonb NOT NULL DEFAULT '[]'::jsonb,max_open_tasks integer CHECK(max_open_tasks>0),notes text,revision integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_shift_templates_property_idx ON staff_shift_templates(property_id);
