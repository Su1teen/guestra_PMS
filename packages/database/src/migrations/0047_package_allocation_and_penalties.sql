-- Additive: how an included package component is counted for reports, and the revenue split of a stay.
-- NULL / defaults keep current behaviour for every existing component and reservation.
ALTER TABLE rate_plan_components ADD COLUMN IF NOT EXISTS basis varchar(30);
ALTER TABLE rate_plan_components ADD COLUMN IF NOT EXISTS allocation_amount numeric(12,2);
ALTER TABLE rate_plan_components ADD COLUMN IF NOT EXISTS unit_cost numeric(12,2);
ALTER TABLE rate_plan_components ADD COLUMN IF NOT EXISTS revenue_category varchar(20);

-- Revenue split of a stay: a snapshot when the booking is confirmed, then correcting rows; past rows are never rewritten.
-- Category 'penalty' rows record a retained prepayment, 'refund' rows a returned payment, with who and why.
CREATE TABLE IF NOT EXISTS reservation_revenue_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  reservation_id uuid NOT NULL REFERENCES reservations(id),
  kind varchar(20) NOT NULL,
  category varchar(20) NOT NULL,
  component_id uuid,
  description varchar(255) NOT NULL,
  quantity integer NOT NULL DEFAULT 1,
  amount numeric(12,2) NOT NULL,
  cost numeric(12,2) NOT NULL DEFAULT 0,
  currency_code varchar(3) NOT NULL,
  reason text,
  actor_id varchar(120),
  source_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reservation_revenue_allocations_reservation_idx ON reservation_revenue_allocations (property_id, reservation_id);
CREATE INDEX IF NOT EXISTS reservation_revenue_allocations_occurred_idx ON reservation_revenue_allocations (property_id, occurred_at);
