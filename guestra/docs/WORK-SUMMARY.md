# Guestra — итоги работы: что сделано, что осталось, scope

Дата: 2026-10-24. Окружения: прод (только read-only интеграция CRM↔PMS) и sandbox (Railway), AI-агент — только sandbox.

## 1. Scope работы

**В scope**
1. Восстановление CRM после `DATABASE_OWNERSHIP_MISMATCH` (legacy-таблицы AI Studio в БД CRM) и сопутствующих проблем деплоя.
2. Включение read-only интеграции CRM↔PMS (Integration V2) в проде; записи выключены.
3. Изолированный sandbox в Railway (свои БД для PMS, CRM, Studio), подключение AI Studio.
4. 9 пунктов клиентской обратной связи по бронированиям (PMS + CRM).
5. Технический handover по n8n-агенту.
6. Реальный LLM-агент «Айдана» на общем n8n: AI Studio → n8n → CRM → PMS, с инструментами, подтверждением брони гостем и передачей человеку.

**Вне scope / не делалось**
- Запись в прод, платежи, изменение существующих workflow и credentials в n8n.
- Онлайн-оплата и ссылки на оплату (агент их не даёт).
- Перенос агента в прод; отключение legacy Telegram-агента.

## 2. Что сделано

### 2.1 Восстановление CRM и прод
| Проблема | Решение | PR |
|---|---|---|
| `DATABASE_OWNERSHIP_MISMATCH` | модуль карантина legacy-таблиц Studio | CRM #4 |
| `LEGACY_MIGRATION_CHECKSUM_DRIFT` (миграция 0012) | allow-list digest | CRM #5 |
| Дрейф хешей из-за CRLF на Windows | исправлены хеши в sandbox-БД, `.gitattributes` | CRM #6 |
| Прод CRM 502 после деплоя (`PORT=5432`) | `PORT=8080` | — (настройка) |
| Read-only интеграция CRM↔PMS | миграции, затем флаги; записи выключены | — |

### 2.2 Sandbox в Railway
Отдельное окружение `sandbox`: sandbox-PMS, sandbox-CRM, sandbox-Studio, три Postgres, Redis; TCP-прокси на БД; тестовые данные LES; проверены режимы Studio; аттестации владения БД. Описание — `ops/railway/SANDBOX.md` в PMS.

### 2.3 Обратная связь клиента (PMS #18 + CRM #7)
Подтверждение брони, пересчёт цены по составу гостей, групповые номера, кнопка «добавить гостя», компании, сводка доступности, отображение цены, ручная скидка, апгрейд. 23/23 API-проверок в sandbox.

### 2.4 AI-агент «Айдана» на n8n
Workflow (sandbox, версия `aidana-agent-1.0.0+6bad4cb02da0`):
- A — агент `eYOraX7blGzT5PiG` (webhook от Studio → claim → CRM inbound → контекст → LLM с 9 инструментами → ответ через CRM outbound → callbacks)
- B — capabilities `pzvnT6XOtjL3Qq1V`
- C — error & recovery `5K7h5mVjcsLUrphv`
- sub: signed callback `zZiN7gA2BtRFN9pN`, CRM tool gateway `dwIE0EA4dqV2fwPk`

Credentials (имена): `GUESTRA-STUDIO` (OpenAI, gpt-4.1), `GUESTRA-STUDIO · Studio sandbox bearer`, `GUESTRA-STUDIO · CRM sandbox principal`. Контекст диалога хранится в CRM, не в памяти n8n; секреты — не в коде.

### 2.5 Дефекты, найденные и исправленные по ходу
- Signer возвращал сырой HTTP-объект («circular structure») → Studio ставил `completion_unknown`. Исправлено.
- PMS: поиск и прямое бронирование считали цену без состава гостей, quote — с доплатами → `PRICE_CHANGED`. Исправлено в PMS #19.
- CRM принимает лишь короткое явное подтверждение («Да, бронируйте»); агент теперь просит именно эту формулировку.
- Агент выдумывал время заезда, создавал лишние офферы и обещал «подождите» — исправлено правилами промпта и логикой Extract reply.

### 2.6 Результаты E2E (sandbox)
| Проверка | Итог |
|---|---|
| Многошаговый диалог, выбор инструментов по смыслу | ✅ |
| Реальные данные LES через CRM/PMS | ✅ Standard 16 830 KZT / 3 ночи / 2 взрослых |
| Коммерческий запрос | ✅ |
| Оффер + отдельное подтверждение гостя | ✅ |
| Ровно одна бронь: PMS read-back + проекция CRM | ✅ `HAIP-82M7Z1B091Y2W5V021B1B380J0P7E0Y6`, `assigned`, 1 booking / 1 reservation, операция `operation_4f86bd76-…` `completed` |
| Жалоба → передача человеку | ✅ `human_owned`, ИИ дальше молчит |
| Дубликат сообщения | ✅ 1 входящее, 1 ответ |
| Отображение ответа и доставки в Studio | ✅ run `completed` |
| Workflow C (аварийный callback) | ⚠ не прогнан сквозным тестом |
| Потеря ответа / recovery | ⚠ не прогнан, покрыт только контрактом Studio |

## 3. Что нужно сделать (по приоритету)

**Решения владельца**
1. Что делать с гостем при передаче человеку: сейчас он не получает подтверждения (CRM блокирует сообщения ИИ при `human_owned`). Нужно системное сообщение или правка CRM.
2. Прод: включать ли `CRM_PMS_INTEGRATION_ENABLED` и как быть с legacy Telegram-агентом.
3. Перевыпустить секреты, попавшие в чат: токен Telegram, ключ OpenAI, пароль и ключи n8n.

**Доработки**
4. Прогнать сквозные тесты workflow C (искусственная авария) и потери ответа / recovery.
5. Привести поле `model` в настройках агента в Studio к gpt-4.1.
6. Почистить данные sandbox PMS: дубликат категории Suite (цена 495 KZT выглядит аномально).
7. Проверить в UI n8n, что клик по узлу «Aidana LLM» открывает модель, а не Webhook (после замены ID узлов на UUID).
8. Закоммитить папку `guestra/` и handover отдельной веткой/PR (сейчас не закоммичено).
9. Перед выходом в прод: отдельная проверка нагрузки/таймингов (прогон занимает ~11–19 с), политика retry callbacks, мониторинг ошибок workflow C.

## 4. Где что лежит
- `guestra/README.md` — схема выполнения, ID, результаты E2E.
- `guestra/n8n/` — сборщики и деплой workflow, E2E-драйвер, `workflows/*.json` (экспорт без секретов).
- `guestra/docs/n8n-agent-handover.md` — технический handover.
- PMS: `ops/railway/SANDBOX.md`, `docs/plans/client-feedback-reservations.md`.
- Конфиги с секретами (`n8n.env`, `studio.env`) — только локально, в git не коммитить.
