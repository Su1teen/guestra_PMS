import { pgTable, uuid, varchar, text, boolean, timestamp, jsonb, date, pgEnum, integer, primaryKey, index } from 'drizzle-orm/pg-core';
import { properties } from './property.js';

/**
 * Channel connection status (KB 6.1).
 */
export const channelStatusEnum = pgEnum('channel_status', [
  'active',
  'inactive',
  'error',
  'pending_setup',
]);

/**
 * ARI sync direction.
 */
export const syncDirectionEnum = pgEnum('sync_direction', [
  'push',
  'pull',
  'bidirectional',
]);

/**
 * Channel Connections — one per property per channel (KB 6.1).
 * Channel managers (SiteMinder, DerbySoft) or direct OTA connections.
 * Syncs ARI (Availability, Rates, Inventory) outbound and reservations inbound.
 */
export const channelConnections = pgTable('channel_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  propertyId: uuid('property_id').notNull().references(() => properties.id),

  channelCode: varchar('channel_code', { length: 50 }).notNull(),
  channelName: varchar('channel_name', { length: 100 }).notNull(),
  adapterType: varchar('adapter_type', { length: 50 }).notNull(),

  status: channelStatusEnum('status').notNull().default('pending_setup'),
  syncDirection: syncDirectionEnum('sync_direction').notNull().default('bidirectional'),

  // Adapter configuration (credentials, endpoints — encrypt secrets at app level)
  config: jsonb('config').$type<Record<string, unknown>>(),

  // Rate plan mapping: PMS rate plans → channel rate codes
  ratePlanMapping: jsonb('rate_plan_mapping').$type<Array<{
    ratePlanId: string;
    channelRateCode: string;
  }>>(),

  // Room type mapping: PMS room types → channel room codes
  roomTypeMapping: jsonb('room_type_mapping').$type<Array<{
    roomTypeId: string;
    channelRoomCode: string;
  }>>(),

  // Sync state
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  lastSyncStatus: varchar('last_sync_status', { length: 20 }),
  lastSyncError: text('last_sync_error'),
  lastReservationPullAt: timestamp('last_reservation_pull_at', { withTimezone: true }),

  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Durable receipt and delivery work for a committed channel revision. */
export const channelRevisionReceipts = pgTable('channel_revision_receipts', {
  propertyId: uuid('property_id').notNull().references(() => properties.id, { onDelete: 'cascade' }),
  channelConnectionId: uuid('channel_connection_id').notNull().references(() => channelConnections.id, { onDelete: 'cascade' }),
  revisionId: varchar('revision_id', { length: 100 }).notNull(),
  bookingId: uuid('booking_id').notNull(),
  reservationId: uuid('reservation_id').notNull(),
  insertedAt: timestamp('inserted_at', { withTimezone: true }).notNull(),
  startDate: date('start_date'),
  endDate: date('end_date'),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  retryAt: timestamp('retry_at', { withTimezone: true }).notNull().defaultNow(),
  attempts: integer('attempts').notNull().default(0),
}, (table) => ({
  key: primaryKey({ columns: [table.propertyId, table.channelConnectionId, table.revisionId] }),
  booking: index('channel_revision_receipts_booking_idx').on(table.propertyId, table.channelConnectionId, table.bookingId, table.insertedAt),
  pending: index('channel_revision_receipts_pending_idx').on(table.completedAt, table.retryAt),
}));

/**
 * ARI Sync Log — tracks every push/pull for debugging and reconciliation (KB 6.1).
 */
export const ariSyncLogs = pgTable('ari_sync_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  propertyId: uuid('property_id').notNull().references(() => properties.id),
  channelConnectionId: uuid('channel_connection_id').notNull().references(() => channelConnections.id),

  direction: syncDirectionEnum('direction').notNull(),
  action: varchar('action', { length: 50 }).notNull(),

  payload: jsonb('payload'),
  response: jsonb('response'),

  status: varchar('status', { length: 20 }).notNull(),
  errorMessage: text('error_message'),

  roomTypeId: uuid('room_type_id'),
  ratePlanId: uuid('rate_plan_id'),
  dateRangeStart: date('date_range_start'),
  dateRangeEnd: date('date_range_end'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Content Sync Log — tracks descriptive-content pushes (photos, descriptions,
 * amenities) to channels. Mirrors ariSyncLogs but for the content API.
 */
export const contentSyncLogs = pgTable('content_sync_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  propertyId: uuid('property_id').notNull().references(() => properties.id),
  channelConnectionId: uuid('channel_connection_id').notNull().references(() => channelConnections.id),

  direction: syncDirectionEnum('direction').notNull().default('push'),
  action: varchar('action', { length: 50 }).notNull(), // 'content_push'

  payload: jsonb('payload'),
  response: jsonb('response'),

  status: varchar('status', { length: 20 }).notNull(),
  errorMessage: text('error_message'),

  roomTypeId: uuid('room_type_id'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
