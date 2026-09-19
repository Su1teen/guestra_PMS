-- LES is a Kazakhstan demo property. Older seeds attached foreign reference
-- profiles to it and left two active. Keep the reference data, but deactivate
-- only the deterministic seeded rows for the deterministic LES property.
UPDATE tax_profiles
SET is_active = false,
    updated_at = now()
WHERE property_id = 'a0000001-0000-4000-a000-000000000001'
  AND id IN (
    'a5000001-0000-4000-a000-000000000001',
    'a5000001-0000-4000-a000-000000000002',
    'a5000001-0000-4000-a000-000000000003',
    'a5000001-0000-4000-a000-000000000004'
  )
  AND EXISTS (
    SELECT 1
    FROM properties
    WHERE properties.id = tax_profiles.property_id
      AND properties.code = 'LES'
      AND properties.country_code = 'KZ'
  );
