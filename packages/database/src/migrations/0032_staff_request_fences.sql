-- Additive: no booking, financial or guest records are rewritten.
-- Fences have no TTL: forgetting a token would permit a delayed request to create a stay.
CREATE TABLE IF NOT EXISTS staff_request_fences (
  property_id uuid NOT NULL REFERENCES properties(id),
  request_id uuid NOT NULL,
  closed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, request_id)
);
