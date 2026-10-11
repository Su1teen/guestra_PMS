import {
  pgTable,
  uuid,
  timestamp,
  varchar,
  jsonb,
  integer,
  text,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { properties } from './property.js';
import { users } from './rbac.js';

/** Explicit operational shifts; no inferred payroll, rest-period or labour-law policy. */
export const staffShifts = pgTable(
  'staff_shifts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    endAt: timestamp('end_at', { withTimezone: true }).notNull(),
    kind: varchar('kind', { length: 20 }).notNull().default('shift'),
    absenceType: varchar('absence_type', { length: 20 }),
    status: varchar('status', { length: 20 }).notNull().default('planned'),
    breaks: jsonb('breaks')
      .$type<Array<{ startAt: string; endAt: string }>>()
      .notNull()
      .default([]),
    maxOpenTasks: integer('max_open_tasks'),
    notes: text('notes'),
    revision: integer('revision').notNull().default(1),
    idempotencyKey: varchar('idempotency_key', { length: 200 }).notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('staff_shifts_property_time_idx').on(
      t.propertyId,
      t.startAt,
      t.endAt,
    ),
    uniqueIndex('staff_shifts_property_request_unique').on(
      t.propertyId,
      t.idempotencyKey,
    ),
  ],
);

/** Reusable patterns materialize explicit shifts in the existing calendar. */
export const staffShiftTemplates = pgTable(
  'staff_shift_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    name: varchar('name', { length: 100 }).notNull(),
    weekdays: jsonb('weekdays').$type<number[]>().notNull(),
    startTime: varchar('start_time', { length: 5 }).notNull(),
    endTime: varchar('end_time', { length: 5 }).notNull(),
    overnight: integer('overnight').notNull().default(0),
    breaks: jsonb('breaks')
      .$type<
        Array<{
          startTime: string;
          endTime: string;
          startDay: number;
          endDay: number;
        }>
      >()
      .notNull()
      .default([]),
    maxOpenTasks: integer('max_open_tasks'),
    notes: text('notes'),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('staff_shift_templates_property_idx').on(t.propertyId)],
);
