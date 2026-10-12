ALTER TABLE rate_plans ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision > 0);
ALTER TABLE rate_restrictions ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision > 0);
CREATE TABLE rate_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES properties(id),
  rate_plan_id uuid NOT NULL REFERENCES rate_plans(id), status varchar(20) NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','approved','applied','rejected')),
  revision integer NOT NULL DEFAULT 1 CHECK(revision > 0), expected_plan_revision integer NOT NULL,
  state_token varchar(64) NOT NULL, change jsonb NOT NULL, preview jsonb NOT NULL,
  reason text NOT NULL, requested_by varchar(255), approved_by varchar(255), decision_reason text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rate_change_requests_property_status_idx ON rate_change_requests(property_id,status,created_at);
CREATE TABLE rate_mutation_fences (
  property_id uuid NOT NULL REFERENCES properties(id), request_id uuid NOT NULL,
  fingerprint varchar(64) NOT NULL, actor_key varchar(255) NOT NULL,
  status varchar(20) NOT NULL CHECK(status IN ('running','committed','closed')), response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(property_id,request_id)
);
