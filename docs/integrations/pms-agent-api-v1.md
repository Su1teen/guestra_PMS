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
| create_guest_request | `POST /guest-requests` | yes | serviceRequestId |
| capabilities | `GET /capabilities` | no | enabled contract features |

`integrationContext` is optional and opaque to PMS. With `sourceSystem: "guestra_crm"`, it may carry `customerId`, `requestId`, `offerId`, `reservationId`, `conversationId`, and `operationId`. PMS persists only identity/correlation links and returns them in the related domain event; it does not interpret CRM workflow state.

Before confirmation, an agent must use category and rate-plan IDs returned by PMS search, not a room number. Room numbers are operational information and may be shown only in the appropriate verified in-house context.
