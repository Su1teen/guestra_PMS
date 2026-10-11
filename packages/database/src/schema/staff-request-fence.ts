import { pgTable, uuid, timestamp, primaryKey } from 'drizzle-orm/pg-core';
import { properties } from './property.js';

/** Terminal request tokens prevent a delayed staff-create from creating a duplicate stay. */
export const staffRequestFences = pgTable('staff_request_fences', {
  propertyId: uuid('property_id').notNull().references(() => properties.id),
  requestId: uuid('request_id').notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.propertyId, t.requestId] })]);
