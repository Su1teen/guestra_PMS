# PMS Agent API v1

All endpoints are under `/api/v1/connect`, require `x-api-key`, and are property-scoped. Mutation calls use a caller-stable `idempotencyKey`; a retry with the same payload returns the existing result, while a changed payload returns `IDEMPOTENCY_CONFLICT`.

| Tool | Method and path | Write | Key output |
| --- | --- | --- | --- |
| search_accommodation | `POST /search` | no | category, rate, authoritative price |
| get_property | `GET /properties/:id` | no | property detail |
| book_accommodation | `POST /book` | yes | bookingId, reservationId, confirmationNumber |
| get_booking | `GET /bookings/:confirmationNumber/verify` | no | lifecycle and room assignment state |
| modify_booking | `PATCH /bookings/:confirmationNumber` | yes | revised reservation |
| cancel_booking | `DELETE /bookings/:confirmationNumber` | yes | cancellation outcome |
| get_service_options | `GET /services?propertyId=` | no | stable code, price, policy |
| check_service_availability | `POST /services/availability` | no | live capacity result |
| book_service | `POST /services/book` | yes | serviceBookingId, folioId |
| get_service_booking | `GET /services/bookings/:id?propertyId=` | no | status, revision, accepted amount |
| modify_service_booking | `PATCH /services/bookings/:id` | yes | revised time/participants, preserved amount |
| cancel_service_booking | `POST /services/bookings/:id/cancel` | yes | capacity cancellation, manual financial review |
| create_guest_request | `POST /guest-requests` | yes | serviceRequestId |
| capabilities | `GET /capabilities` | no | enabled contract features |

`integrationContext` is optional and opaque to PMS. With `sourceSystem: "guestra_crm"`, it may carry `customerId`, `requestId`, `offerId`, `reservationId`, `conversationId`, and `operationId`. PMS persists only identity/correlation links and returns them in the related domain event; it does not interpret CRM workflow state.

Before confirmation, an agent must use category and rate-plan IDs returned by PMS search, not a room number. Room numbers are operational information and may be shown only in the appropriate verified in-house context.

## Service operations

Availability accepts `quantity`, `participants`, and optional property-linked `guestId` for guest tax exemptions. Time values require an explicit offset. Booking accepts optional `expectedTotal` as a decimal string; a stale quote returns HTTP 409 `PRICE_CHANGED` and creates no guest, allocation, folio or charge. A catalog service must explicitly configure `taxMode` (`none`, `exclusive`, `inclusive`). Historical bookings keep accepted prices and remain replayable when the catalog changes. Do not auto-fill a tax policy during migration.

Move/cancel require `propertyId`, `idempotencyKey` and `expectedRevision`. A move preserves duration, quantity, currency, accepted pricing and ledger, and rechecks live capacity inside the same transaction. External tools cannot select an internal resource. No-show penalties are disabled. Cancellation releases capacity but does not reverse charges or refund a payment; a staff member uses the existing folio and payment workflow.

For read-only service credentials use scopes `["pms:scoped:v1", "services.read"]`; add `services.write` for approved mutations. The marker alone denies all service tools. Historical empty/opaque scope metadata and platform keys retain their documented compatibility; migrate those credentials explicitly before claiming least privilege across the full Connect API. Other modules' capability enforcement remains a P2-F gate.

The staff UI uses `/api/v1/services/*`, JWT/property/RBAC guards, and the same `ConnectServiceBookingService`. Its `GET /booking-request?propertyId=&idempotencyKey=` recovers a committed booking after an uncertain response. A 404 is not proof that an in-flight request cannot later commit: retry only the original payload with its original key. Staff detail hides the folio's full balance/payments; those require the separate folio permission.

The staff recovery banner persists only the random request key per actor/property in session storage, never a customer or financial payload. `POST /booking-request/close` accepts `propertyId` and the **original** `idempotencyKey`. It serializes with creation: an accepted request returns `{status:"committed",serviceBookingId}` unchanged; an unaccepted request returns `{status:"closed"}` and fences any late POST with `SERVICE_REQUEST_CLOSED`. A missing GET alone never permits abandoning an in-flight request.

`GET /resources/:id/slots?propertyId=&startAt=&endAt=` provides a single-day, consistent capacity snapshot, including frozen buffers, working windows and blocks. It is not a hold. `PATCH /resources/:id` requires `services.manage`, a new operation key and `expectedUpdatedAt`. Capacity/hours/deactivation cannot invalidate future scheduled bookings; existing allocation buffers stay frozen. `GET /bookings?propertyId=&reservationId=` requires services/reservation read access and exposes scheduled stay extras separately from existing package/stay-service rows.

Domain events retain existing `service_booking.created`, `service_booking.rescheduled`, `service_booking.cancelled`, `service_booking.completed` names. Charge events and lifecycle events use the existing transactional outbox, stable logical event IDs, HMAC delivery/retry and audit storage. Consumers deduplicate by logical event ID. Public booking detail excludes allocation IDs, internal notes, integration context and idempotency fingerprints.

```sh
# Use an authorized non-production endpoint and a property-bound credential.
curl "$PMS_URL/api/v1/connect/services/bookings/$BOOKING_ID?propertyId=$PROPERTY_ID" -H "x-api-key: $PMS_KEY"
curl -X POST "$PMS_URL/api/v1/connect/services/bookings/$BOOKING_ID/cancel" \
  -H "x-api-key: $PMS_KEY" -H 'Content-Type: application/json' \
  --data '{"propertyId":"10000000-0000-4000-a000-000000000001","expectedRevision":1,"idempotencyKey":"crm-cancel-unique-operation-id"}'
```

For n8n store one key per logical operation before submitting, reuse it on network retry, and retain the returned revision. Read back after writes. Route HTTP 409 to staff review; never auto-create a second operation with a new key after an ambiguous timeout. The example UUID must be replaced with the credential's actual property.
