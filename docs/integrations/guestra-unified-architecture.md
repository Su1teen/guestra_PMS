# Guestra unified architecture

Guestra CRM owns customer identity, messages, conversations, commercial requests and offers. Guestra PMS owns property inventory, prices, bookings, stays, guests, folios, operational services and guest requests. n8n is an orchestration and reconciliation layer only: it never writes either PostgreSQL database directly.

| CRM context | PMS operational truth |
| --- | --- |
| Customer | Guest (`integration_links` provides the durable mapping) |
| Request | No PMS equivalent required |
| Offer | PMS search/rate quote context |
| Reservation mirror | Booking and Reservation |
| Stay context | Reservation lifecycle |
| ServiceReservation mirror | ServiceBooking |
| GuestRequest mirror | ServiceRequest |
| Folio context | Folio |

The PMS commits its own transaction first and emits a signed domain webhook. n8n then mirrors or reconciles CRM state. Replaying the same operation key is safe; sending a changed payload with that key is rejected. PMS does not call CRM and does not own conversations or sales leads.

Accommodation is sold by room category and authoritative PMS rate. A physical room is assigned internally after an inventory lock and overlap recheck. A service-only guest has a property link, a ServiceBooking and, where charged, a standalone folio—never a fabricated stay.

Lifecycle mapping is derived rather than duplicated: `confirmed`/`assigned` → pre-arrival, `checked_in`/`stayover` → in-house, `due_out` → due-out, `checked_out` → post-stay, and `cancelled`/`no_show` → terminal.
