import {
  pgTable,
  uuid,
  date,
  varchar,
  text,
  integer,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { properties } from './property.js';
import { rooms } from './room.js';
import { maintenanceTickets } from './ops.js';

/** Physical-room unavailability uses the existing half-open stay-night convention. */
export const roomInventoryBlocks = pgTable(
  'room_inventory_blocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id),
    maintenanceTicketId: uuid('maintenance_ticket_id').references(
      () => maintenanceTickets.id,
    ),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    kind: varchar('kind', { length: 3 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('active'),
    reason: text('reason').notNull(),
    revision: integer('revision').notNull().default(1),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('room_inventory_blocks_property_room_date_idx').on(
      t.propertyId,
      t.roomId,
      t.startDate,
      t.endDate,
    ),
  ],
);
