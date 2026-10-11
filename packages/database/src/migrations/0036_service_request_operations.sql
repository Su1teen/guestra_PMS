ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS linked_maintenance_ticket_id uuid REFERENCES maintenance_tickets(id);
CREATE INDEX IF NOT EXISTS service_requests_property_maintenance_idx ON service_requests(property_id,linked_maintenance_ticket_id);
