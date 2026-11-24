-- Additive. Remote payment requests (an invoice sent to the guest's payment app, e.g. Kaspi by phone)
-- for a reservation prepayment. Nothing existing changes; the table is empty until a property is enabled.
CREATE TABLE IF NOT EXISTS remote_payment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  reservation_id uuid NOT NULL REFERENCES reservations(id),
  booking_id uuid NOT NULL REFERENCES bookings(id),
  provider varchar(20) NOT NULL,
  mode varchar(10) NOT NULL CHECK (mode IN ('test', 'live')),
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  currency_code varchar(3) NOT NULL,
  phone_masked varchar(24) NOT NULL,
  phone_digest varchar(64) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'creating'
    CHECK (status IN ('creating', 'unknown', 'sent', 'paid', 'failed', 'expired', 'cancelled')),
  provider_invoice_id varchar(64),
  provider_status varchar(30),
  pay_url text,
  provider_expires_at timestamptz,
  payment_id uuid REFERENCES payments(id),
  paid_at timestamptz,
  refunded_amount numeric(12,2),
  error_code varchar(60),
  review_reason varchar(40),
  source varchar(20) NOT NULL,
  requested_by varchar(200),
  conversation_id varchar(200),
  check_attempts integer NOT NULL DEFAULT 0,
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS remote_payment_requests_reservation_idx ON remote_payment_requests (property_id, reservation_id);
CREATE UNIQUE INDEX IF NOT EXISTS remote_payment_requests_invoice_unique ON remote_payment_requests (provider, provider_invoice_id);
CREATE UNIQUE INDEX IF NOT EXISTS remote_payment_requests_open_unique ON remote_payment_requests (property_id, reservation_id)
  WHERE status IN ('creating', 'sent', 'unknown');
CREATE INDEX IF NOT EXISTS remote_payment_requests_open_idx ON remote_payment_requests (status, last_checked_at);
