CREATE TABLE IF NOT EXISTS sandbox_remote_prepayments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  reservation_id uuid NOT NULL REFERENCES reservations(id),
  amount numeric(12, 2) NOT NULL CHECK (amount > 0 AND amount = trunc(amount)),
  phone_digest text NOT NULL,
  provider_invoice_id text,
  provider_status text,
  payment_id uuid REFERENCES payments(id),
  paid_at timestamptz,
  review_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, reservation_id),
  UNIQUE (provider_invoice_id)
);
