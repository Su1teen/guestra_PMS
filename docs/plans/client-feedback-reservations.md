# Client feedback: reservations workflow (pilot property)

Source: front-desk feedback from a live pilot. Scope is iterative improvement of existing flows,
not a rewrite. PMS stays the operational authority; CRM keeps the commercial view.

| # | Feedback | Finding in code | Change |
|---|---|---|---|
| 1 | Booking confirmation for the guest | No guest confirmation in PMS. CRM renderer has an unused `RESERVATION_CONFIRMATION` kind. | PMS `GET /v1/reservations/:id/confirmation` (data + printable HTML) and `POST .../confirmation/send` (email via existing EmailService, audited). Data from reservation, booking, property (address, contacts, check-in/out times), room type, rate plan (meal plan, cancellation policy), booked services, deposit/payment state. CRM: `/reservations/:id/confirmation` printable document. |
| 2 | Adding a guest does not recalculate the price | Pricing is per room only; `addGuest` raises `adults` but never reprices. | Optional per-rate-plan supplements `extra_adult_amount` / `extra_child_amount` above the room type `default_occupancy` (additive migration, null = current behaviour). Canonical pricing applies them; staff quote/create, Connect v2 and the guest add/remove path reprice the stay before arrival unless the price was set manually. |
| 3 | Group bookings | Groups exist (profiles, allotment blocks, rooming list). Staff create is one room at a time; extra rooms only via split. | `POST /v1/reservations/:id/rooms` adds another room to the same booking (same confirmation number, own room type/rate/guests, canonical quote). Party panel lists all rooms of the booking. Group blocks unchanged. |
| 4 | "Add guest" button disabled | The reservation drawer renders the party panel read-only. | Allow guest changes in the drawer for users with `reservations.write`; read-only only for closed statuses, with an explanation. |
| 5 | Create / edit / delete a company | Companies are `group_profiles` (corporate, agency…). Create and edit exist, no removal. | `is_active` on group profiles (additive). Delete when nothing references the company, otherwise deactivate; reactivate supported. List filter for inactive companies. |
| 6 | Availability overview | Tape chart colours cells; no per-category totals. | Availability summary on the calendar: per room type and date — total, booked, out of order/blocked, available. `outOfOrder` added to availability rows. |
| 7 | Price not shown while choosing room/dates | New-reservation wizard lists rate plans without amounts. | Wizard quotes every rate plan through the canonical quote endpoint (dates + occupancy) and shows stay total and per-night average; room types that cannot fit the party are hidden. |
| 8 | Manual price change / discount | Only the Booking Request flow supports custom prices. | `POST /v1/reservations/:id/pricing` sets a new total, a percentage or an amount discount with a mandatory reason. Stored as an accepted pricing snapshot (`source: custom`), audit log with before/after. |
| 9 | Room upgrade | `modify` refuses room type changes on priced reservations. | `POST /v1/reservations/:id/upgrade`: availability check under the inventory lock, new room type/rate plan, pricing `keep` (complimentary), `reprice` or `custom` with reason; unassigns an incompatible room; audited; confirmation reflects the new data. |

Safety: every endpoint is property-scoped and requires `reservations.write`; price changes and
upgrades also require a reason and are written to the audit log with before/after values. Closed
reservations are refused. Changes go through the accepted pricing snapshot and open folios are
reconciled, so night audit posts the new tariff. The reservation row change is captured by the
Integration V2 triggers, so CRM projections update without a separate sync path.

Open points for the hotel (not decided in code):
- Occupancy supplements are configured per rate plan; their amounts are hotel policy.
- The confirmation's payment terms text is generic until the hotel provides its own wording.
