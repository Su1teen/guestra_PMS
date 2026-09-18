-- Per-property instant-booking retry guard and persisted successful response.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS idempotency_key varchar(200);
CREATE UNIQUE INDEX IF NOT EXISTS bookings_property_idempotency_key_unique
  ON bookings(property_id, idempotency_key);

CREATE TABLE IF NOT EXISTS booking_engine_idempotency (
  property_id uuid NOT NULL REFERENCES properties(id),
  idempotency_key varchar(200) NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, idempotency_key)
);

-- Existing demo seeds skip an already-present LES property. Backfill only
-- missing guestInfo, preserving operator changes and all other settings.
UPDATE properties
SET settings = jsonb_set(
  COALESCE(settings, '{}'::jsonb),
  '{guestInfo}',
  '{"pets":"Проживание с питомцами согласуйте заранее с администрацией.","children":"Можно приехать с детьми; укажите их возраст и запрос на дополнительное место при бронировании.","parking":"Парковка для гостей на территории; доступность места уточняйте перед приездом.","breakfast":"Завтрак можно добавить к проживанию; состав и стоимость уточняйте при бронировании.","restaurant":"По вопросам питания и бронирования столика обратитесь к администрации.","spa":"SPA-процедуры доступны по предварительной записи; наличие свободного времени уточняйте заранее.","bath":"Посещение бани согласовывается отдельно; условия и свободное время уточняйте заранее.","transfer":"Трансфер возможен по предварительному запросу; сообщите маршрут и время прибытия.","smoking":"Условия для курящих и расположение специально отведённых мест уточняйте у администрации.","wifi":"Wi-Fi доступен гостям; данные для подключения предоставят при заселении."}'::jsonb
)
WHERE id = 'a0000001-0000-4000-a000-000000000001'
  AND code = 'LES'
  AND (settings->'guestInfo') IS NULL;
