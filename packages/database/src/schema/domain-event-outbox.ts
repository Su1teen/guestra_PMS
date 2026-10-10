import { pgTable, uuid, varchar, timestamp, jsonb, integer, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { properties } from './property.js';
/** Staff reservation events committed with the operation; delivered after commit. */
export const domainEventOutbox = pgTable('domain_event_outbox', {
  id: uuid('id').primaryKey().defaultRandom(), propertyId: uuid('property_id').notNull().references(() => properties.id),
  logicalEventId: varchar('logical_event_id', { length: 200 }).notNull(), payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  attempts: integer('attempts').notNull().default(0), availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('domain_event_outbox_property_event_unique').on(t.propertyId, t.logicalEventId), index('domain_event_outbox_pending_idx').on(t.deliveredAt, t.availableAt)]);
