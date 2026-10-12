ALTER TABLE charges ADD COLUMN revenue_role varchar(32) NOT NULL DEFAULT 'earned';
ALTER TABLE charges ADD CONSTRAINT charges_revenue_role_check
  CHECK (revenue_role IN ('earned', 'deposit_credit'));

-- Previous deposit applications had no durable FK/source key. Attribute only
-- the exact shape emitted by DepositService, with a unique scoped deposit AND
-- charge match. Do not classify arbitrary description matches as liabilities.
WITH candidate AS (
  SELECT c.id AS charge_id, d.id AS deposit_id, c.property_id,
    count(*) OVER (PARTITION BY c.id) AS deposits_per_charge,
    count(*) OVER (PARTITION BY d.id) AS charges_per_deposit
  FROM charges c
  JOIN folios f ON f.id = c.folio_id AND f.property_id = c.property_id AND f.currency_code = c.currency_code
  JOIN deposit_ledger_entries d ON d.property_id = c.property_id
    AND d.reservation_id = f.reservation_id AND d.currency_code = c.currency_code
    AND d.status = 'applied' AND d.recognized_at IS NOT NULL
    AND c.amount = -d.amount
    AND abs(extract(epoch FROM (d.recognized_at - c.service_date))) < 60
  WHERE c.type = 'adjustment' AND c.description = 'Deposit applied'
    AND c.source_key IS NULL AND c.is_reversal = false
    AND c.parent_charge_id IS NULL AND c.original_charge_id IS NULL
    AND c.adjusts_charge_id IS NULL AND c.tax_amount = 0
    AND c.tax_rate IS NULL AND c.tax_code IS NULL
), unique_match AS (
  SELECT * FROM candidate WHERE deposits_per_charge = 1 AND charges_per_deposit = 1
), updated AS (
UPDATE charges c SET revenue_role = 'deposit_credit',
  source_key = 'deposit:' || m.deposit_id::text || ':apply'
FROM unique_match m WHERE c.id = m.charge_id AND c.property_id = m.property_id
  AND NOT EXISTS (SELECT 1 FROM charges present WHERE present.property_id = c.property_id
    AND present.source_key = 'deposit:' || m.deposit_id::text || ':apply')
RETURNING c.id, c.property_id, c.source_key
)
INSERT INTO audit_logs (property_id, action, entity_type, entity_id, description, new_value)
SELECT property_id, 'update', 'charge', id, 'Migration 0040: verified legacy deposit application',
  jsonb_build_object('revenueRole', 'deposit_credit', 'sourceKey', source_key) FROM updated;

-- Signed reversals of those identified credits are also liabilities, not income.
WITH candidate AS (
  SELECT c.id, c.property_id, p.source_key,
    count(*) OVER (PARTITION BY p.id) AS reversals_per_original
  FROM charges c JOIN charges p ON p.id = c.original_charge_id
    AND p.property_id = c.property_id AND p.folio_id = c.folio_id
  WHERE p.revenue_role = 'deposit_credit' AND c.is_reversal = true
    AND c.type = 'adjustment' AND c.amount = -p.amount AND c.source_key IS NULL
    AND c.currency_code = p.currency_code
), updated AS (
  UPDATE charges c SET revenue_role = 'deposit_credit', source_key = m.source_key || ':reversal'
  FROM candidate m WHERE m.reversals_per_original = 1 AND c.id = m.id AND c.property_id = m.property_id
    AND NOT EXISTS (SELECT 1 FROM charges present WHERE present.property_id = c.property_id
      AND present.source_key = m.source_key || ':reversal')
  RETURNING c.id, c.property_id, c.source_key
)
INSERT INTO audit_logs (property_id, action, entity_type, entity_id, description, new_value)
SELECT property_id, 'update', 'charge', id, 'Migration 0040: verified legacy deposit credit reversal',
  jsonb_build_object('revenueRole', 'deposit_credit', 'sourceKey', source_key) FROM updated;

-- One-time attribution of the exact fees emitted by cancellation/night-audit
-- settlement. Require state/time/currency/property/reservation agreement and
-- a unique fee of each kind. Ambiguous historical rows need manual review.
WITH candidate AS (
  SELECT c.id, c.property_id, f.reservation_id,
    CASE WHEN c.description = 'No-show fee' THEN 'additional' ELSE 'policy' END AS kind,
    count(*) OVER (PARTITION BY c.property_id, f.reservation_id,
      CASE WHEN c.description = 'No-show fee' THEN 'additional' ELSE 'policy' END) AS matches
  FROM charges c JOIN folios f ON f.id = c.folio_id AND f.property_id = c.property_id AND f.currency_code = c.currency_code
  JOIN reservations r ON r.id = f.reservation_id AND r.property_id = f.property_id
    AND r.currency_code = c.currency_code
  WHERE c.type = 'fee' AND c.amount > 0 AND c.source_key IS NULL AND c.is_reversal = false
    AND f.type = 'guest' AND c.parent_charge_id IS NULL AND c.original_charge_id IS NULL
    AND c.adjusts_charge_id IS NULL
    AND ((r.status = 'cancelled' AND c.description = 'Cancellation penalty'
        AND abs(extract(epoch FROM (c.service_date - r.cancelled_at))) < 60)
      OR (r.status = 'no_show' AND c.description IN ('No-show penalty', 'No-show fee')
        AND abs(extract(epoch FROM (c.service_date - r.updated_at))) < 60))
    AND EXISTS (SELECT 1 FROM deposit_ledger_entries d WHERE d.property_id = r.property_id
      AND d.reservation_id = r.id AND d.currency_code = c.currency_code)
), updated AS (
  UPDATE charges c SET source_key = 'settlement:' || m.reservation_id::text || ':' || m.kind
  FROM candidate m WHERE m.matches = 1 AND c.id = m.id AND c.property_id = m.property_id
    AND NOT EXISTS (SELECT 1 FROM charges present WHERE present.property_id = c.property_id
      AND present.folio_id = c.folio_id
      AND present.source_key = 'settlement:' || m.reservation_id::text || ':' || m.kind)
  RETURNING c.id, c.property_id, c.source_key
)
INSERT INTO audit_logs (property_id, action, entity_type, entity_id, description, new_value)
SELECT property_id, 'update', 'charge', id, 'Migration 0040: verified legacy settlement provenance',
  jsonb_build_object('sourceKey', source_key) FROM updated;

ALTER TABLE charges ADD CONSTRAINT charges_deposit_credit_source_check
  CHECK (revenue_role <> 'deposit_credit' OR
    (type = 'adjustment' AND source_key IS NOT NULL AND source_key LIKE 'deposit:%'));
CREATE UNIQUE INDEX charges_deposit_source_unique ON charges(property_id, source_key)
  WHERE source_key LIKE 'deposit:%';
