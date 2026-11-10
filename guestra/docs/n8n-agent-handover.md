# Handover: n8n AI Agent для Guestra

Проверено 24.10.2026 на `main`: Studio `c860d81`, CRM `f62c91d`, PMS `58485a0`.
В production, Railway и базах ничего не менялось, использовались только чтения. Секреты не раскрываются.

## Сначала главное

1. **Включённый флаг ломает старого Telegram-агента в проде.**
   - При `CRM_PMS_INTEGRATION_ENABLED=true` CRM отвечает `409 PMS_V2_REQUIRED` на операционные пути v1: `/accommodations/options|availability|book`, `/offers/create`, `/services/*`, `/stay-context`, `/folio-summary`, `/guest-requests`, `/stays/*` (код: `guestra_crm/server/integration/router.ts`, строки 47–55).
   - Работают только inbound, контекст, база знаний, запросы, handoff и результат доставки.
   - Контракт CRM прямо говорит «не включать v2 до миграции потребителей». Флаг был включён по указанию, но последствие для Telegram-потока не оценивалось.
   - Работает ли старый workflow сейчас: **NOT VERIFIED**. В проде есть 15 Telegram-диалогов и заданный `AGENT_OUTBOUND_WEBHOOK_URL`.
2. **n8n-принципала в CRM нет ни в проде, ни в sandbox**, нет учётных данных n8n, нет workflow и публичных webhook-URL.
3. **Studio не принимает claims в проде по дизайну:** требуется `STUDIO_SANDBOX=true` и окружение `sandbox` или `test`. Значит, n8n запускается только против sandbox-Studio.

## 1. Интеграционная готовность

| Контур | Проверено | Статус |
|---|---|---|
| CRM `/v2/capabilities`, `/readiness` | живой ответ 200, `ready: true` | работает |
| PMS `/v2/capabilities`, diagnostics | живой ответ 200, `ready: true` | работает |
| Studio discovery CRM/PMS | в sandbox оба `CONNECTED`, `mappingReady: true` | работает |
| CRM sandbox-фикстуры + PMS read-back | `confirmed_reservation` создана в sandbox, повтор идемпотентен | проверено вживую |
| Отмена в PMS → проекция CRM | `cancelled` через ≈15 с, опрос событий | проверено вживую |
| Studio → n8n claim/events/media | код: `guestra_ai_studio/server/orchestration.ts` | только mock/PGlite |
| CRM v2 offers/book/actions/guest-requests, services | локальный изолированный набор (две БД, реальный HTTP, 7/7), CI | **не проверено на живом sandbox** |
| `/v2/messages/outbound/prepare` + `/messages/outbound/result` | код и локальные тесты | не проверено вживую |
| `/v2/media/*` | код и тесты, сканера нет | не проверено |
| PMS Inbox | `GUESTRA_INBOX_ENABLED=false` | UI проверен на HTTP-заглушках |

Анонимные чтения CRM `search`, `services` и `inspector` вернули `VALIDATION_ERROR`: они требуют существующую идентичность клиента и диалога. Без записи это не проверить, поэтому вживую они **NOT VERIFIED**.

## 2. Базы данных

Три независимые Postgres, подтверждено запросами в обе стороны:

| Среда | Система | Сервис БД | Идентичность и аттестация | Миграции |
|---|---|---|---|---|
| prod | PMS | `haip-postgres` | `guestra_pms` · production · `guestra-pms-prod-db-v1` | журнал 23, `core/0043`, `integration/0001_domain_event_capture_v2` |
| prod | CRM | `Postgres` | `guestra_crm` · production · `guestra-crm-prod-db-v1` | журнал 17, `integration/0001_cross_database_v2` |
| prod | Studio | `postgres-wz2f` | `guestra_ai_studio` · production · `guestra-studio-prod-db-v1` | `001`, `002`, `003` |
| sandbox | PMS / CRM / Studio | `Postgres-KK5L` / `-Rdla` / `-THWH` | то же, окружение `sandbox`, id `…-sandbox-db-v1` | как в проде |

- **Чужих таблиц нет** ни в одной из шести баз. Проверялись таблицы CRM, PMS, Studio и n8n (`workflow_entity`, `execution_entity`).
- **Legacy-таблицы Studio:** в CRM лежат в схеме `legacy_ai_studio` (24 таблицы, из них 23 перенесённых), в `public` их нет. Там остались 1 workspace, 1 конфигурация агента и 4 сценария. Их сравнение с боевой Studio-базой не делалось.
- **Подключения:** `DATABASE_URL` каждого из 6 приложений указывает на свою базу, переменные владельца и deployment id совпадают.
- **Предупреждение:** в sandbox-PMS остались тестовые данные сценария (гости Scenario, брони, категория Suite, доплаты в тарифе). В прод-PMS эти данные не попадали.

## 3. Активация (факт на Railway)

| Флаг | prod | sandbox |
|---|---|---|
| `GUESTRA_INTEGRATION_V2_ENABLED` (PMS) | true | true |
| `CRM_PMS_INTEGRATION_ENABLED` (CRM) | true | true |
| `GUESTRA_INTEGRATION_MIGRATIONS_APPROVED` | true (PMS, CRM) | true |
| `GUESTRA_REGISTRY_ENABLED` | true | true |
| `GUESTRA_BUSINESS_WRITES_ENABLED` | **false** | true |
| `GUESTRA_SANDBOX_SETUP_ENABLED` | false | true |
| `GUESTRA_INBOX_ENABLED` | false | false |
| `STUDIO_SANDBOX` / `STUDIO_ENVIRONMENT` | false / production | true / sandbox |

В sandbox записи включены автоматически: в CRM `businessWritesEnabled` истинно при любом окружении, кроме `production`. Для n8n в проде нужен `GUESTRA_BUSINESS_WRITES_ENABLED=true`, но это решение отдельное и после sandbox-E2E.

## 4. Property mappings

| Среда | CRM propertyId | CRM tenantId | PMS propertyId = tenantId | Studio workspace |
|---|---|---|---|---|
| LES Боровое, prod | `les_borovoe` | `org_les_live` | `a0000001-0000-4000-a000-000000000001` | `les-sandbox` |
| sandbox | `sandbox_les` | `org_les_live` | `b4d34b21-e0fb-47b4-9b53-72f4e2ba7d2a` | `les-sandbox` |

Подтверждено API, а не предположением: CRM `/v2/capabilities` возвращает `verifiedMapping: true`, `operationalAuthority: guestra_pms`, deployment `guestra-crm-prod-db-v1`, PMS capabilities возвращают те же property и tenant. В БД это ещё и строка `integration_mappings` (property↔property) в CRM и ссылка `integration_links` в PMS. Workspace `les-sandbox` в Studio-базе имеет режим `preview`.

Замечание: в CRM есть ещё `les_astana` без PMS-маппинга. n8n её использовать нельзя.

## 5. API и авторизация

**Реальные capabilities (prod):**
- CRM: `guestra-crm-integration-v2`, `features: durableOperations, guestMessageChanges, operationReceipts`.
- PMS: `guestra-connect-v2`, `ownership: guests, inventory, reservations, stays, services, folios, payments`, `features: acceptedQuote, operationReceipts, durableEvents, authoritativeReadBack`, **`paymentLinks: false`**.

**Принципалы сейчас:**
- CRM prod: `studio-read` (`integration.read`, `agent.read`, `inspector.read`; workspace `les-sandbox`) и `pms-inbox`.
- CRM sandbox: ещё `sandbox-operator` с `sandbox.setup`.
- PMS: `guestra-studio-read` (`integration.read`) и `guestra-crm-service` (read, write, events; в sandbox ещё `sandbox.setup`).

**Нужно добавить:**
- **n8n-принципал в CRM:** `integration.read/write`, `agent.read/write`, `inspector.read`, `media.*`, опционально `integration.reconcile`/`events.*`, плюс `tool:<name>` только на нужные инструменты, `workspaceIds: [les-sandbox]`. Готовый JSON лежит в `n8n-later.env` (`CRM_PRINCIPAL_TO_REGISTER_LATER`) локально, вне репозитория. Регистрируется через `CRM_INTEGRATION_PRINCIPALS`.
- **Studio-принципал:** сейчас у него только чтение. Для отправки inbound в режиме CRM Connected нужен `agent.write`, для сценарных фикстур — `sandbox.setup`.
- **n8n не получает:** `PMS_COMMAND_SECRET`, прямой PMS-ключ записи, DB-доступ.
- **Studio ↔ n8n:** `N8N_TOKEN` (≥32) и отдельный `N8N_CALLBACK_SECRET` (≥32). В проде оба заданы (64 и 96 символов), **в sandbox-Studio нет вообще**.

**Можно ли использовать Studio → CRM → PMS без изменений кода?** Только для чтения и discovery (проверено). Для записи (inbound, фикстуры) нужна конфигурация, не код.

## 6. Сообщения и синхронизация

- **Inbound:** `POST /messages/inbound`, уникальный индекс `messages_idempotency_uidx`, ключ собирается из property/channel/chat/user/message id. Повтор возвращает то же сообщение. Событие фиксируется в `integration_events`.
- **Outbound:** `prepare` создаёт сообщение в состоянии pending (HTTP 200 это не доставка). Доставку подтверждает только `POST /messages/outbound/result`.
- **Transcript и доставка:** `GET /v2/conversations/:id/changes` (after/limit, `guest-message-changes-v1`), с отдельным курсором коммитов и tombstones.
- **Media:** трёхшаговая схема (`reference` → clean → одноразовый URL). Сканера и хранилища нет, `MEDIA_DIR=/app/media` без подтверждённого тома. Для медиа **REQUIRES CONFIG**.
- **Handoff:** `/handoff`, владение разговором липкое, поздний AI-ответ отклоняется. PMS Inbox использует `/v2/inbox/:id/takeover`, не включён.
- **Дубли и рестарт:**
  - Studio: durable claim в своей Postgres, повтор того же `executionId` с `resume`, другие executionId получают `execute=false`.
  - Studio: события подписаны HMAC, неизменяемые, с монотонным sequence.
  - CRM: рестарт-устойчивый цикл восстановления каждые 15 с (`startIntegrationRecovery`: команды, inbox PMS, лента событий) и inbox с отпечатком события.
  - PMS: чеки операций и outbox в одной транзакции.
- Рестарты n8n/Studio на каждой границе на живой среде **не проверялись**.

## 7. Маршрут бронирования

availability → quote → Offer → доставленное предложение → подтверждение гостя → PMS booking → read-back → проекция CRM.

- **Код есть на всех шагах:** `/v2/accommodations/search` → `/v2/offers` (подписанная котировка PMS) → `/v2/messages/outbound/prepare` + `/result` → `/v2/accommodations/book` (нужны доставленное предложение, позднее подтверждение гостя, совпадение payload, текущее AI-владение) → `/v2/operations/:id` → проекция.
- **Проверено локально:** изолированный набор из 7 тестов: 14 состояний, дубли, смена цены, потеря ответа. Подтверждённая бронь и отмена из PMS в CRM проверены вживую в sandbox. Шаги Offer → book на живом sandbox **NOT VERIFIED**.
- **Блокеры:**
  - нет n8n-принципала и самого workflow;
  - `paymentLinks: false`, платежи в потоке только как pending или simulated;
  - в CRM-режиме суммы целочисленные KZT, дробные или иные валюты отклоняются (`CRM_MONEY_PRECISION_UNSUPPORTED`);
  - поведение модели не проверено.
- **В sandbox end-to-end сейчас выполнимо:** фикстуры, поиск, создание Offer/бронь/услуги/гостевой запрос через CRM-фасад, отмена и изменение, чтение по операциям, события. Реальный AI-агент выполнить нельзя.

## 8. n8n: старый Telegram workflow против blueprint

Старый (`guestra_crm/integrations/n8n/guestra-crm-telegram-agent.workflow.json`): 43 узла, Telegram Trigger, AI Tools Agent 3.1, OpenAI Chat, Structured Output Parser, 24 инструмента v1 (`httpRequestTool 4.5`), без БД и памяти. Установленная версия n8n: **NOT VERIFIED** (публичный `/rest/settings` её не раскрывает, `/healthz` 200).

- **Переиспользовать:** AI Agent 3.1, модель и Structured Output Parser, системный промпт (`GUESTRA_AGENT_SYSTEM_PROMPT.md`), шаблон `CONFIG` и guard'ы, Webhook + Respond to Webhook 2.1/1.4, схему `CRM • Ingest` → guards → `Prepare Reply` → отправка → `Delivery Success/Failure`.
- **Заменить:** Telegram Trigger/Send → Webhook `guestra-studio` и CRM `outbound/result`; все инструменты v1 → v2:
  - `Accommodation Options/Availability` → `/v2/accommodations/search`;
  - `Create Offer` → `/v2/offers`;
  - `Book Accommodation` → `/v2/accommodations/book`;
  - `Service Options/Availability` → `/v2/services` и `/v2/services/availability`;
  - `Book/Reschedule/Cancel Service` и amend/cancel accommodation → `/v2/actions`;
  - `Create Guest Request` → `/v2/guest-requests`;
  - `Stay Context` и `Folio Summary` → `/v2/context`;
  - `Extend Stay` — v2-аналога в blueprint нет.
- **Добавить с нуля:**
  - **Workflow A** (вход): валидация envelope + claim `/api/integrations/n8n/claims` + быстрый ответ + inbound/context/media/ownership + агент + инструменты + опрос чеков + prepare/result + подписанные callbacks.
  - **Workflow B:** capabilities (GET, должен вернуть `studio-gateway-v1`, окружение, `inboundOwner: n8n`, `durableClaim: studio-claim-v1`, реальные `workflowId`/`deploymentId`, property и workspaceIds).
  - **Workflow C:** Error Trigger/recovery.
- Webhook-путь в старом workflow `guestra-telegram-outbound` общий для других задач. Новый путь не должен пересекаться. n8n один на несколько проектов («n8n + waha»), старые workflow и credentials трогать нельзя.
- Studio проверяет capabilities строго (сверка окружения, property, tenants, `workspaceIds`). Любое расхождение даёт `WORKFLOW_NOT_DEPLOYED` или `ENVIRONMENT_MISMATCH`.

## 9. Промпты и модели

Готово в Studio: неизменяемые версии промптов и тест-версии, заморозка (хеш, модель, tools, flags) в каждом запуске, жизненный цикл (`STUDIO_PUBLISHED`, `N8N_DEPLOYMENT_PENDING`, `N8N_DEPLOYED`, `DEPLOYMENT_FAILED`, `ROLLED_BACK`), инжектируемый интерфейс `PromptPublisher` с проверкой чтением. Публикатор по умолчанию отключён и честно возвращает `WORKFLOW_NOT_DEPLOYED`.

Не закрыто: настоящий публикатор под установленный n8n (версия и права публичного API не проверены), список разрешённых workflow, чтение активной версии/хеша и откат, API-ключ n8n только на бэкенде, одобрение модели и ключа провайдера. В проде у промпта нет признака деплоя.

## 10. Тесты и среда запуска

- **CI на main зелёный:** PMS 2593 теста (локально прогнаны и PG16/PG18 smoke), CRM CI, Studio (56 SQL-тестов на изолированной Postgres, 10 браузерных).
- **Изолированный стенд PMS+CRM+Studio-адаптер:** 7/7. Это не настоящий n8n и не LLM.
- **Живой sandbox в Railway:** `sandbox-pms`, `sandbox-crm`, `sandbox-studio` + три Postgres + Redis, отдельные ключи, аттестация `sandbox`. Подходит как среда для настоящего workflow после настройки (разделы 5 и 8).
- **Нужно для запуска:** n8n-принципал, `N8N_TOKEN`/`N8N_CALLBACK_SECRET`/`N8N_WEBHOOK_URL`/`N8N_CAPABILITIES_URL` в sandbox-Studio, хост n8n (`n8nion8n-production-57b1.up.railway.app`) в `INTEGRATION_ALLOWED_HOSTS`.
- **Мелкие расхождения в документации Studio:** она называет Railway-проект `lovely-art` (id тот же, имя другое), БД `postgres_ai_studio` (фактически `postgres-wz2f`) и привязана к старым SHA CRM/PMS.

## Итоговая таблица

| Область | Статус |
|---|---|
| Три БД, владельцы, аттестации, легаси-схема | READY |
| CRM/PMS capabilities и маппинг LES (prod, sandbox) | READY |
| Studio → CRM → PMS discovery | READY |
| Sandbox среда (сервисы, БД, фикстуры, ленты событий) | READY |
| Studio claim/events/media API | READY (проверено локально), REQUIRES CONFIG для запуска |
| CRM v2 write-цепочка (Offer, book, services) | READY в коде, NOT VERIFIED на живом sandbox |
| n8n принципал, токены, URL, хост в allowlist | REQUIRES CONFIG |
| Права Studio (`agent.write`, `sandbox.setup`) | REQUIRES CONFIG |
| Три workflow (A, B, C) | REQUIRES CODE |
| PromptPublisher под установленный n8n | REQUIRES CODE |
| Media (сканер, постоянное хранилище) | REQUIRES CONFIG + CODE |
| Платёжные ссылки / деньги | REQUIRES CODE |
| Версия n8n, Public API, политика credentials | NOT VERIFIED |
| Работа старого Telegram-агента в проде | NOT VERIFIED (после флага деградирует) |
| Настоящий AI/LLM, E2E с n8n | NOT VERIFIED |
| PMS Inbox | REQUIRES CONFIG, UI на заглушках |

## Блокирующие проблемы

1. Деградация старого Telegram-агента в проде (решение за владельцем).
2. Нет n8n-принципала, токенов и workflow.
3. Нет `agent.write`/`sandbox.setup` у Studio.
4. Версия n8n и политика credentials неизвестны, инстанс общий.
5. Media-сканер и постоянное хранилище.
6. `paymentLinks: false`.

## Следующие задачи по порядку

1. Решить судьбу флага в проде (отключить до готовности n8n или мигрировать Telegram на v2).
2. Прочитать версию n8n и доступные ноды, решить схему credentials и создания workflow (под владельцем n8n-проекта), без изменений существующих.
3. Сгенерировать и зарегистрировать n8n-принципал в sandbox-CRM, добавить `agent.write`/`sandbox.setup` принципалу Studio.
4. Добавить в sandbox-Studio `N8N_TOKEN`, `N8N_CALLBACK_SECRET`, `N8N_WEBHOOK_URL`, `N8N_CAPABILITIES_URL`, расширить allowlist, включить workspace `les-sandbox` для sandbox.
5. Workflow B (capabilities) и Workflow A до ответа claim, проверка discovery `sandboxReady`.
6. Подключить inbound, контекст, handoff, ownership.
7. Добавить инструменты (search, offers, book, services, actions, guest-requests) и опрос `/v2/operations/:id`.
8. outbound `prepare` → доставка → `/messages/outbound/result`, подписанные callbacks.
9. Workflow C и повторные запросы, потеря ответа, рестарты.
10. E2E матрица в sandbox (E2E_TEST_PLAN, 9 групп).
11. Media (сканер, том, обмен).
12. PromptPublisher, затем решение по продовым записям.
