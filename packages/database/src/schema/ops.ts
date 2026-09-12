import { pgTable, uuid, varchar, text, timestamp, pgEnum, integer, jsonb, boolean, index } from 'drizzle-orm/pg-core';
import { properties } from './property.js';
import { rooms } from './room.js';
import { reservations } from './reservation.js';
import { guests } from './guest.js';
import { housekeepingTasks } from './housekeeping.js';
import { users } from './rbac.js';

/** Lost-and-found item lifecycle: held in storage, returned to guest, or disposed. */
export const lostAndFoundCategoryEnum = pgEnum('lost_and_found_category', [
  'general',
  'baggage',
  'parcel',
  'valet',
]);

export const lostAndFoundStatusEnum = pgEnum('lost_and_found_status', [
  'held',
  'returned',
  'disposed',
]);

/**
 * Items found on property — bagged, tagged, and held for a retention period
 * before disposal.
 */
export const lostAndFoundItems = pgTable('lost_and_found_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  propertyId: uuid('property_id').notNull().references(() => properties.id),
  roomId: uuid('room_id').references(() => rooms.id),
  reservationId: uuid('reservation_id').references(() => reservations.id),
  guestId: uuid('guest_id').references(() => guests.id),
  category: lostAndFoundCategoryEnum('category').notNull().default('general'),
  description: text('description').notNull(),
  tagCode: varchar('tag_code', { length: 50 }).notNull(),
  status: lostAndFoundStatusEnum('status').notNull().default('held'),
  foundAt: timestamp('found_at', { withTimezone: true }).notNull().defaultNow(),
  disposeAfter: timestamp('dispose_after', { withTimezone: true }).notNull(),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const serviceRequestStatusEnum = pgEnum('service_request_status', [
  'open',
  'assigned',
  'in_progress',
  'done',
  'completed',
  'cancelled',
]);

/** Service request types — aligned with housekeeping task types where applicable. */
export const serviceRequestTypeEnum = pgEnum('service_request_type', [
  'maintenance',
  'turndown',
  'deep_clean',
  'checkout',
  'stayover',
  'inspection',
  'service_request',
  'housekeeping',
  'late_checkout',
  'early_checkin',
  'extra_towel',
  'extra_blanket',
  'spa_booking',
  'restaurant_request',
  'transfer',
  'breakfast',
  'technical_problem',
  'other',
]);

/**
 * Guest or staff service requests that may spawn or link to a housekeeping task.
 */
export const serviceRequests = pgTable('service_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  propertyId: uuid('property_id').notNull().references(() => properties.id),
  roomId: uuid('room_id').references(() => rooms.id),
  reservationId: uuid('reservation_id').references(() => reservations.id),
  guestId: uuid('guest_id').references(() => guests.id),
  type: serviceRequestTypeEnum('type').notNull(),
  category: varchar('category', { length: 80 }),
  department: varchar('department', { length: 80 }),
  priority: integer('priority').notNull().default(0),
  status: serviceRequestStatusEnum('status').notNull().default('open'),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description'),
  linkedTaskId: uuid('linked_task_id').references(() => housekeepingTasks.id),
  requestedBy: uuid('requested_by'),
  assigneeId: uuid('assignee_id').references(() => users.id),
  dueAt: timestamp('due_at', { withTimezone: true }),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  slaDeadline: timestamp('sla_deadline', { withTimezone: true }),
  comments: jsonb('comments').$type<Array<{
    id: string;
    body: string;
    authorId?: string | null;
    createdAt: string;
  }>>().notNull().default([]),
  attachments: jsonb('attachments').$type<Array<{
    url: string;
    name?: string;
    contentType?: string;
  }>>().notNull().default([]),
  createdBy: uuid('created_by').references(() => users.id),
  completedBy: uuid('completed_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const maintenanceCategoryEnum = pgEnum('maintenance_category', [
  'hvac',
  'plumbing',
  'electrical',
  'furniture',
  'appliance',
  'internet',
  'lighting',
  'bathroom',
  'safety',
  'other',
]);

export const maintenancePriorityEnum = pgEnum('maintenance_priority', [
  'low',
  'normal',
  'high',
  'critical',
]);

export const maintenanceStatusEnum = pgEnum('maintenance_status', [
  'open',
  'assigned',
  'in_progress',
  'waiting_parts',
  'resolved',
  'closed',
  'cancelled',
]);

/**
 * Engineering/maintenance work orders. Resolving a ticket never makes a room
 * sellable by itself: an OOO room remains blocked until return-to-service is
 * explicitly confirmed, at which point the established room workflow sends it
 * to vacant_dirty for housekeeping/inspection.
 */
export const maintenanceTickets = pgTable('maintenance_tickets', {
  id: uuid('id').primaryKey().defaultRandom(),
  propertyId: uuid('property_id').notNull().references(() => properties.id),
  roomId: uuid('room_id').references(() => rooms.id),
  reservationId: uuid('reservation_id').references(() => reservations.id),
  guestId: uuid('guest_id').references(() => guests.id),
  category: maintenanceCategoryEnum('category').notNull().default('other'),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description').notNull(),
  priority: maintenancePriorityEnum('priority').notNull().default('normal'),
  status: maintenanceStatusEnum('status').notNull().default('open'),
  department: varchar('department', { length: 80 }).notNull().default('maintenance'),
  assigneeId: uuid('assignee_id').references(() => users.id),
  reportedBy: uuid('reported_by').references(() => users.id),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  slaDeadline: timestamp('sla_deadline', { withTimezone: true }),
  resolution: text('resolution'),
  comments: jsonb('comments').$type<Array<{
    id: string;
    body: string;
    authorId?: string | null;
    createdAt: string;
  }>>().notNull().default([]),
  attachments: jsonb('attachments').$type<Array<{
    url: string;
    name?: string;
    contentType?: string;
  }>>().notNull().default([]),
  blocksInventory: boolean('blocks_inventory').notNull().default(false),
  returnToServiceRequired: boolean('return_to_service_required').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('maintenance_tickets_property_status_idx').on(t.propertyId, t.status),
  index('maintenance_tickets_property_room_idx').on(t.propertyId, t.roomId),
  index('maintenance_tickets_property_sla_idx').on(t.propertyId, t.slaDeadline),
]);
