CREATE TABLE channel_revision_receipts (
    property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    channel_connection_id uuid NOT NULL REFERENCES channel_connections(id) ON DELETE CASCADE,
    revision_id varchar(100) NOT NULL,
    booking_id uuid NOT NULL,
    reservation_id uuid NOT NULL,
    inserted_at timestamptz NOT NULL,
    start_date date,
    end_date date,
    acknowledged_at timestamptz,
    completed_at timestamptz,
    retry_at timestamptz NOT NULL DEFAULT now(),
    attempts integer NOT NULL DEFAULT 0,
    PRIMARY KEY (property_id, channel_connection_id, revision_id)
);

CREATE INDEX channel_revision_receipts_booking_idx
    ON channel_revision_receipts (property_id, channel_connection_id, booking_id, inserted_at);

CREATE INDEX channel_revision_receipts_pending_idx
    ON channel_revision_receipts (completed_at, retry_at);
