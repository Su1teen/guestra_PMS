-- Explicit opt-in only. Local PMS transactions populate the existing outbox.
CREATE TABLE IF NOT EXISTS integration_event_heads (
 property_id uuid PRIMARY KEY REFERENCES properties(id) ON DELETE CASCADE,sequence bigint NOT NULL CHECK(sequence>0)
);
CREATE OR REPLACE FUNCTION guestra_operational_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 body jsonb:=to_jsonb(NEW);previous jsonb;prop uuid:=(body->>'property_id')::uuid;
 entity uuid:=(body->>'id')::uuid;entity_kind text;event_name text;next_seq bigint;event_id uuid:=gen_random_uuid();
 context jsonb;reservation_ref uuid;tenant uuid;envelope jsonb;guest_ref uuid;
BEGIN
 IF TG_OP='UPDATE' THEN previous:=to_jsonb(OLD); IF body=previous THEN RETURN NEW;END IF; END IF;
 IF prop IS NULL THEN RETURN NEW;END IF;
 entity_kind:=CASE TG_TABLE_NAME WHEN 'reservations' THEN 'reservation' WHEN 'service_bookings' THEN 'service_booking'
  WHEN 'service_requests' THEN 'service_request' WHEN 'folios' THEN 'folio' WHEN 'payments' THEN 'payment' WHEN 'charges' THEN 'folio' END;
 IF entity_kind IS NULL THEN RETURN NEW;END IF;
 event_name:=entity_kind||CASE WHEN TG_OP='INSERT' THEN '.created' ELSE '.updated' END;
 IF TG_TABLE_NAME='reservations' THEN
  reservation_ref:=entity;
  IF TG_OP='UPDATE' THEN event_name:='reservation.modified';END IF;
  IF TG_OP='UPDATE' AND body->>'status' IS DISTINCT FROM previous->>'status' THEN
  IF body->>'status'='cancelled' THEN event_name:='reservation.cancelled';
  ELSIF body->>'status' IN ('checked_in','stayover') THEN event_name:='reservation.checked_in';
  ELSIF body->>'status'='checked_out' THEN event_name:='reservation.checked_out';
  ELSIF body->>'status' IN ('confirmed','assigned') AND TG_OP='UPDATE' THEN event_name:='reservation.confirmed';END IF;
  END IF;
 ELSIF TG_TABLE_NAME='service_bookings' AND TG_OP='UPDATE' THEN
  IF body->>'status'='cancelled' AND previous->>'status' IS DISTINCT FROM body->>'status' THEN event_name:='service_booking.cancelled';
  ELSIF body->>'status'='completed' AND previous->>'status' IS DISTINCT FROM body->>'status' THEN event_name:='service_booking.completed';
  ELSIF body->>'start_at' IS DISTINCT FROM previous->>'start_at' OR body->>'end_at' IS DISTINCT FROM previous->>'end_at' THEN event_name:='service_booking.rescheduled';END IF;
 ELSIF TG_TABLE_NAME='service_requests' AND TG_OP='UPDATE' AND body->>'status' IN ('done','completed') AND body->>'status' IS DISTINCT FROM previous->>'status' THEN
  event_name:='service_request.completed';
 ELSIF TG_TABLE_NAME='charges' THEN entity:=(body->>'folio_id')::uuid;
  event_name:=CASE WHEN (body->>'is_reversal')::boolean THEN 'folio.charge_reversed' ELSE 'folio.charge_posted' END;
 ELSIF TG_TABLE_NAME='payments' THEN
  IF body->>'original_payment_id' IS NOT NULL AND body->>'status'='captured' THEN event_name:='payment.refunded';
  ELSIF body->>'status' IN ('captured','settled','refunded','partially_refunded','failed','voided') THEN event_name:='payment.'||(body->>'status');
  ELSIF TG_OP='UPDATE' THEN event_name:='payment.status_changed';END IF;
 END IF;
 IF reservation_ref IS NULL THEN reservation_ref:=NULLIF(body->>'reservation_id','')::uuid;END IF;
 IF reservation_ref IS NULL AND body->>'folio_id' IS NOT NULL THEN SELECT reservation_id INTO reservation_ref FROM folios WHERE id=(body->>'folio_id')::uuid AND property_id=prop;END IF;
 guest_ref:=NULLIF(body->>'guest_id','')::uuid;
 IF guest_ref IS NULL AND body->>'folio_id' IS NOT NULL THEN SELECT guest_id INTO guest_ref FROM folios WHERE id=(body->>'folio_id')::uuid AND property_id=prop;END IF;
 IF guest_ref IS NULL AND reservation_ref IS NOT NULL THEN SELECT guest_id INTO guest_ref FROM reservations WHERE id=reservation_ref AND property_id=prop;END IF;
 IF reservation_ref IS NOT NULL THEN
  SELECT b.integration_context INTO context FROM reservations r JOIN bookings b ON b.id=r.booking_id AND b.property_id=prop WHERE r.id=reservation_ref AND r.property_id=prop;
 END IF;
 context:=coalesce(context,body->'integration_context');
 SELECT coalesce(organization_id,id) INTO tenant FROM properties WHERE id=prop;
 -- The counter row is held until commit: polling cannot skip a slower commit.
 INSERT INTO integration_event_heads VALUES(prop,1) ON CONFLICT(property_id)
 DO UPDATE SET sequence=integration_event_heads.sequence+1 RETURNING sequence INTO next_seq;
 envelope:=jsonb_build_object('schemaVersion','guestra-domain-event-v1','eventId',event_id,'sourceSystem','guestra_pms',
  'propertyId',prop,'tenantId',tenant,'entityType',entity_kind,'entityId',entity,'revision',next_seq,'eventType',event_name,'occurredAt',clock_timestamp());
 IF guest_ref IS NOT NULL THEN envelope:=envelope||jsonb_build_object('guestId',guest_ref);END IF;
 IF context->>'sourceSystem'='guestra_crm' AND context->>'customerId' IS NOT NULL THEN
  envelope:=envelope||jsonb_build_object('integrationContext',jsonb_strip_nulls(jsonb_build_object('sourceSystem','guestra_crm','customerId',context->>'customerId',
   'requestId',context->>'requestId','offerId',context->>'offerId','conversationId',context->>'conversationId','operationId',context->>'operationId')),
   'correlationId',coalesce(context->>'operationId',context->>'conversationId',''));
 END IF;
 INSERT INTO domain_event_outbox(id,property_id,logical_event_id,payload) VALUES(event_id,prop,event_id::text,
  jsonb_build_object('event',event_name,'entityType',entity_kind,'entityId',entity,'propertyId',prop,'data',jsonb_build_object('integrationEnvelope',envelope),
   'timestamp',clock_timestamp(),'integrationEnvelope',envelope));
 RETURN NEW;
END $$;
DO $$
DECLARE tab text;
BEGIN
 FOREACH tab IN ARRAY ARRAY['reservations','service_bookings','service_requests','folios','charges','payments'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='guestra_integration_'||tab) THEN
   EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION guestra_operational_event()','guestra_integration_'||tab,tab);
  END IF;
 END LOOP;
END $$;
CREATE TABLE IF NOT EXISTS connect_operations_v2 (
 property_id uuid NOT NULL REFERENCES properties(id), operation_key text NOT NULL, customer_id text NOT NULL,
 fingerprint text NOT NULL, entity_type text NOT NULL, entity_id uuid NOT NULL, result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(property_id,operation_key)
);
-- A counter is disposable only when its entire property has been removed.
ALTER TABLE integration_event_heads DROP CONSTRAINT IF EXISTS integration_event_heads_property_id_fkey;
ALTER TABLE integration_event_heads ADD CONSTRAINT integration_event_heads_property_id_fkey FOREIGN KEY(property_id) REFERENCES properties(id) ON DELETE CASCADE;
CREATE OR REPLACE FUNCTION guestra_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.property_id<>OLD.property_id OR NEW.logical_event_id<>OLD.logical_event_id OR NEW.payload<>OLD.payload THEN
  RAISE EXCEPTION 'IMMUTABLE_DOMAIN_EVENT';
 END IF;
 RETURN NEW;
END $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='guestra_event_immutable_trigger') THEN
  CREATE TRIGGER guestra_event_immutable_trigger BEFORE UPDATE ON domain_event_outbox FOR EACH ROW EXECUTE FUNCTION guestra_event_immutable();
 END IF;
END $$;

CREATE TABLE IF NOT EXISTS guestra_integration_deployment (
 id boolean PRIMARY KEY DEFAULT true CHECK(id),environment text NOT NULL CHECK(environment IN ('test','sandbox','production')),
 deployment_id text NOT NULL UNIQUE
);
-- Older baseline installations may not have the opt-in Connect credential table.
CREATE TABLE IF NOT EXISTS connect_credentials (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 property_id uuid NOT NULL REFERENCES properties(id),
 label varchar(200) NOT NULL, key_hash varchar(64) NOT NULL UNIQUE,
 is_active boolean NOT NULL DEFAULT true, last_used_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
 scopes jsonb NOT NULL DEFAULT '[]'::jsonb
);
ALTER TABLE connect_credentials ADD COLUMN IF NOT EXISTS scopes jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS guestra_sandbox_properties (
 property_id uuid PRIMARY KEY REFERENCES properties(id),tenant_id text NOT NULL,
 room_type_id uuid NOT NULL,rate_plan_id uuid NOT NULL,service_id uuid
);
CREATE TABLE IF NOT EXISTS guestra_sandbox_fixtures (
 property_id uuid NOT NULL REFERENCES properties(id),fixture_key text NOT NULL,fingerprint text NOT NULL,
 customer_id text NOT NULL,stage text NOT NULL,refs jsonb NOT NULL,expires_at timestamptz NOT NULL,
 retired_at timestamptz,simulated_payment jsonb,PRIMARY KEY(property_id,fixture_key)
);
