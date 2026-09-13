-- Bring the deterministic demo property forward without touching real tenants.
-- Earlier seed versions used generic room categories and USD. The seed is
-- intentionally idempotent and skips existing data, so deployed demo databases
-- need this one-time, exact-id update.

UPDATE properties
SET name = 'ЛЕС Боровое',
    code = 'LES',
    currency_code = 'KZT',
    country_code = 'KZ',
    timezone = 'Asia/Almaty',
    default_language = 'ru',
    settings = jsonb_set(
      jsonb_set(
        jsonb_set(coalesce(settings, '{}'::jsonb), '{earlyCheckInFee}', '22500'::jsonb, true),
        '{lateCheckoutFee}', '33750'::jsonb, true
      ),
      '{noShowFeeAmount}', '75000'::jsonb, true
    ),
    updated_at = now()
WHERE id = 'a0000001-0000-4000-a000-000000000001';

UPDATE room_types
SET name = 'Sky House', code = 'SKY', max_occupancy = 2,
    default_occupancy = 2, updated_at = now()
WHERE property_id = 'a0000001-0000-4000-a000-000000000001'
  AND id = 'b0000001-0000-4000-a000-000000000001';

UPDATE room_types
SET name = 'A-Frame', code = 'AFR', max_occupancy = 4,
    default_occupancy = 2, updated_at = now()
WHERE property_id = 'a0000001-0000-4000-a000-000000000001'
  AND id = 'b0000001-0000-4000-a000-000000000002';

UPDATE room_types
SET name = 'Forest House — 2 guests', code = 'FOR2', max_occupancy = 2,
    default_occupancy = 2, updated_at = now()
WHERE property_id = 'a0000001-0000-4000-a000-000000000001'
  AND id = 'b0000001-0000-4000-a000-000000000003';

UPDATE room_types
SET name = 'Forest House — 6 guests', code = 'FOR6', max_occupancy = 6,
    default_occupancy = 4, updated_at = now()
WHERE property_id = 'a0000001-0000-4000-a000-000000000001'
  AND id = 'b0000001-0000-4000-a000-000000000004';

UPDATE rooms
SET room_type_id = CASE
      WHEN number BETWEEN '101' AND '110' THEN 'b0000001-0000-4000-a000-000000000001'::uuid
      WHEN number BETWEEN '201' AND '210' THEN 'b0000001-0000-4000-a000-000000000002'::uuid
      WHEN number BETWEEN '301' AND '310' THEN 'b0000001-0000-4000-a000-000000000003'::uuid
      WHEN number BETWEEN '401' AND '410' THEN 'b0000001-0000-4000-a000-000000000004'::uuid
      ELSE room_type_id
    END,
    updated_at = now()
WHERE property_id = 'a0000001-0000-4000-a000-000000000001';

UPDATE agent_configs
SET config = coalesce(config, '{}'::jsonb) ||
      '{"variableCostPerRoom":12500,"fcpar":30000}'::jsonb,
    updated_at = now()
WHERE property_id = 'a0000001-0000-4000-a000-000000000001'
  AND agent_type = 'revenue_manager';

UPDATE agent_configs
SET config = coalesce(config, '{}'::jsonb) || '{"revparTarget":120000}'::jsonb,
    updated_at = now()
WHERE property_id = 'a0000001-0000-4000-a000-000000000001'
  AND agent_type = 'pricing';

UPDATE rate_plans
SET room_type_id = 'b0000001-0000-4000-a000-000000000001',
    name = 'Sky House BAR', code = 'SKY-BAR', base_amount = 85000.00,
    currency_code = 'KZT', updated_at = now()
WHERE property_id = 'a0000001-0000-4000-a000-000000000001'
  AND id = 'd0000001-0000-4000-a000-000000000001';

UPDATE rate_plans
SET room_type_id = 'b0000001-0000-4000-a000-000000000002',
    name = 'A-Frame BAR', code = 'AFR-BAR', base_amount = 130000.00,
    currency_code = 'KZT', updated_at = now()
WHERE property_id = 'a0000001-0000-4000-a000-000000000001'
  AND id = 'd0000001-0000-4000-a000-000000000002';

UPDATE rate_plans
SET room_type_id = 'b0000001-0000-4000-a000-000000000003',
    name = 'Forest House 2 BAR', code = 'FOR2-BAR', base_amount = 195000.00,
    currency_code = 'KZT', updated_at = now()
WHERE property_id = 'a0000001-0000-4000-a000-000000000001'
  AND id = 'd0000001-0000-4000-a000-000000000003';

UPDATE rate_plans
SET room_type_id = 'b0000001-0000-4000-a000-000000000004',
    name = 'Forest House 6 BAR', code = 'FOR6-BAR', base_amount = 360000.00,
    currency_code = 'KZT', updated_at = now()
WHERE property_id = 'a0000001-0000-4000-a000-000000000001'
  AND id = 'd0000001-0000-4000-a000-000000000004';

UPDATE rate_plans
SET room_type_id = 'b0000001-0000-4000-a000-000000000002',
    name = 'A-Frame promo', code = 'AFR-PROMO', base_amount = 108000.00,
    currency_code = 'KZT', updated_at = now()
WHERE property_id = 'a0000001-0000-4000-a000-000000000001'
  AND id = 'd0000001-0000-4000-a000-000000000005';

UPDATE services
SET price = CASE code
      WHEN 'BREAKFAST' THEN 12500.00
      WHEN 'PARKING' THEN 20000.00
      WHEN 'LATECO' THEN 22500.00
      ELSE price
    END,
    currency_code = 'KZT',
    updated_at = now()
WHERE property_id = 'a0000001-0000-4000-a000-000000000001';
