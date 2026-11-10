# Guestra — Айдана, AI-агент на n8n (sandbox)

Реальный LLM Tools Agent на общем n8n, подключённый к AI Studio, CRM и PMS (только sandbox, окружение `sandbox` в Railway).
Прод и существующие workflow/credentials не менялись. Секретов в этой папке нет.

## Что внутри

| Путь | Назначение |
|---|---|
| `n8n/build-agent.mjs` | собирает workflow A (агент), B (capabilities), C (error/recovery) |
| `n8n/build-gateway.mjs` | sub-workflow «CRM tool gateway» (9 инструментов агента → CRM v2) |
| `n8n/build-signer.mjs` | sub-workflow «Signed callback» (HMAC-подпись событий в Studio) |
| `n8n/deploy-agent.mjs`, `deploy-signer.mjs` | создают/обновляют и публикуют workflow через n8n Public API |
| `n8n/export-workflows.mjs` | экспорт определений (без значений секретов) в `n8n/workflows/*.json` |
| `n8n/studio-e2e.mjs` | E2E-драйвер: пишет в AI Studio как виртуальный гость |
| `n8n/steps2.mjs` | показывает вызовы инструментов агента в execution |
| `n8n/workflows/*.json` | текущие определения A, B, C, signer, gateway |
| `n8n/created.json` | ID workflow / таблиц / credentials (ID, не значения) |

Конфигурация читается из каталога `GUESTRA_N8N_DIR` (по умолчанию текущий): `n8n.env` (`N8N_URL`, `N8N_API_KEY`), `studio.env` (`ADMIN_EMAIL`, `ADMIN_PASSWORD`), переменная `STUDIO_URL`. Эти файлы в git не коммитить.

## Workflow (n8n)

| Роль | Имя | ID |
|---|---|---|
| A — агент | GUESTRA-STUDIO · Aidana Agent (sandbox) | `eYOraX7blGzT5PiG` |
| B — capabilities | GUESTRA-STUDIO · Capabilities (sandbox) | `pzvnT6XOtjL3Qq1V` |
| C — error / recovery | GUESTRA-STUDIO · Error & Recovery (sandbox) | `5K7h5mVjcsLUrphv` |
| sub: подписанные callbacks | GUESTRA-STUDIO · Signed callback (sub-workflow) | `zZiN7gA2BtRFN9pN` |
| sub: инструменты CRM | GUESTRA-STUDIO · CRM tool gateway (sub-workflow) | `dwIE0EA4dqV2fwPk` |

Версия: `aidana-agent-1.0.0+6bad4cb02da0` (deploymentId = версия + отпечаток определения; отдаётся в B и в callbacks).
Data tables: `guestra_studio_runs` (`R1BqevbljNlvltIb`), таблица секрета callback (`tWLc35OS9rbLXggB`).

Credentials (только имена): `GUESTRA-STUDIO` (OpenAI, модель gpt-4.1), `GUESTRA-STUDIO · Studio sandbox bearer` (Header Auth), `GUESTRA-STUDIO · CRM sandbox principal` (Header Auth). Секрет подписи callback лежит в data table, не в коде.

## Схема выполнения

```
AI Studio ──POST (bearer)──► Studio Webhook ─► Validate envelope ─► Studio claim (durable claim)
        ◄── 202 accepted ── Respond accepted
Remember run ─► CRM inbound ─► [CB inbound_saved]
  ├─ AI не владеет диалогом ─► [CB human_owned] (стоп)
  └─ иначе ─► [CB agent_processing] ─► CRM context v2 (история, факты, active proposal)
        ─► Build agent prompt ─► Aidana Agent (LLM + 9 инструментов, до 8 итераций)
        ─► Extract reply ─► CRM outbound prepare ─► CRM outbound result
        ─► [CB reply_delivered] ─► [CB completed]
Ошибка в A ─► C: Error Trigger ─► найти запуск в data table ─► [CB failed] (sequence 90)
```
`CB …` — подписанный HMAC callback в Studio через sub-workflow signer. Контекст диалога берётся из CRM (не из памяти n8n).

Инструменты агента → действия CRM: `get_property_knowledge`, `search_accommodation`, `get_service_catalog`, `check_service_availability`, `create_or_update_request`, `create_offer`, `book_accommodation`, `get_operation_status`, `handoff_to_human`. Идентификаторы гостя, диалога, отеля и трассировки подставляет gateway, модель их менять не может.

Три разных состояния не смешиваются: *execution success* (workflow n8n отработал), *transport delivery* (сообщение доставлено через CRM outbound, callback `reply_delivered`), *business completion* (операция бронирования `completed` в CRM + запись в PMS).

## Результаты E2E (sandbox, 2026-10-24)

| Проверка | Результат |
|---|---|
| Многошаговый диалог, выбор инструментов по смыслу | ✅ вопрос об отеле → knowledge; даты/состав → поиск; выбор категории → запрос + поиск + оффер |
| Реальные данные LES через CRM/PMS | ✅ цены/наличие из PMS (Standard 16 830 KZT за 3 ночи на 2 взрослых) |
| Коммерческий Request | ✅ `create_or_update_request` |
| Offer и отдельное подтверждение гостя | ✅ оффер → proposal в CRM → отдельное сообщение «Да, бронируйте» |
| Ровно одна sandbox-бронь | ✅ PMS: 1 booking/1 reservation `HAIP-82M7Z1B091Y2W5V021B1B380J0P7E0Y6`, `assigned`, 16 830.00 KZT, 12–15.11, source `agent`; CRM: операция `operation_4f86bd76-…` `completed` + 1 проекция reservation |
| Жалоба + передача человеку | ✅ Studio `human_owned`, следующее сообщение без ответа ИИ |
| Дубликат сообщения (тот же externalMessageId, параллельно) | ✅ 1 входящее, 1 ответ, 2 запуска (по одному на разные сообщения) |
| Run в Studio | ✅ статус `completed`, ответ и состояние доставки видны в timeline Studio |
| Workflow C (failed callback) | ⚠ не прогнан сквозным тестом (нужна искусственная авария) |
| Потеря ответа / recovery | ⚠ не прогнан: покрыто контрактом Studio (`completion_unknown` после maxRetries), своей симуляции не делал |

## Найденные дефекты и исправления

- Signer возвращал сырой HTTP-объект → ошибка «circular structure», Studio не принимал terminal-события и ставил `completion_unknown`. Исправлено (Result — только строка).
- PMS: поиск и прямое бронирование считали цену без состава гостей, а quote — с доплатами → `PRICE_CHANGED` при подтверждении. Исправлено в PMS PR #19 (смержен).
- CRM принимает только короткое явное подтверждение («Да, бронируйте», «Подтверждаю»…); агент просит гостя ответить именно так.
- Агент выдумывал «обычное» время заезда → запрещено правилом промпта.

## Открытые вопросы

- После передачи человеку гость не получает подтверждения от ИИ (CRM блокирует сообщения ИИ при `human_owned`) — решить на стороне продукта (системное сообщение).
- Suite показывает 495 KZT за 3 ночи — похоже на данные сандбокса (дубликат категории Suite), не на логику агента.
- В конфигурации агента в Studio поле `model` нужно привести к gpt-4.1.
- Секреты, которые ранее попали в чат (Telegram-токен, ключ OpenAI, пароль и ключи n8n) — перевыпустить.

## Прод (боевая Studio, 2026-10-26)

Тот же общий n8n, отдельные workflow с суффиксом `(prod)`: агент `qLde4KisvxnR3uzD`, capabilities `cCpt0tSv09WwbJdF`, error `74ISbCTDPULVVYPx`, signer `eHoF8txWqTYXyq5x`, gateway `koyLynixgQ8iuIVW`. Credentials: `GUESTRA-STUDIO · CRM prod principal`, `GUESTRA-STUDIO · Studio prod bearer`, `GUESTRA-STUDIO` (OpenAI, общий). Таблицы: `guestra_studio_prod_secrets`, `guestra_studio_prod_runs`.

Сборка/деплой: `GUESTRA_TARGET=prod GUESTRA_N8N_DIR=<приватная папка с n8n.env> node setup-prod.mjs --crm-principal --n8n --studio`, затем `deploy-signer.mjs`, `build-gateway.mjs`, `deploy-agent.mjs`.

Что включено в проде: live-режим Studio (`STUDIO_LIVE_ORCHESTRATION=true`, guestra_ai_studio PR #4 и #5), принципал `n8n-service` в CRM, `GUESTRA_BUSINESS_WRITES_ENABLED=true` в CRM и в PMS (haip-demo). Запись в CRM/PMS затрагивает и существующего Telegram-агента.

E2E в проде: поиск на реальном инвентаре ЛЕС Боровое, оффер, отдельное подтверждение «Да, бронируйте», 1 бронь в PMS (`HAIP-66K0W7S646H0E0K410D5D22387Z781R3`, Sky House 255 000 KZT, 14–17.03.2027, source `agent`); тестовая бронь затем отменена через API PMS.
