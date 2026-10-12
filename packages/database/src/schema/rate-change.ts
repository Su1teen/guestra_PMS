import { pgTable, uuid, varchar, text, integer, jsonb, timestamp, primaryKey, index } from 'drizzle-orm/pg-core';
import { properties } from './property.js';
import { ratePlans } from './rate-plan.js';

export const rateChangeRequests = pgTable('rate_change_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  propertyId: uuid('property_id').notNull().references(() => properties.id),
  ratePlanId: uuid('rate_plan_id').notNull().references(() => ratePlans.id),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  revision: integer('revision').notNull().default(1),
  expectedPlanRevision: integer('expected_plan_revision').notNull(),
  stateToken: varchar('state_token', { length: 64 }).notNull(),
  change: jsonb('change').$type<Record<string, unknown>>().notNull(),
  preview: jsonb('preview').$type<Record<string, unknown>>().notNull(),
  reason: text('reason').notNull(),
  requestedBy: varchar('requested_by', { length: 255 }),
  approvedBy: varchar('approved_by', { length: 255 }),
  decisionReason: text('decision_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [index('rate_change_requests_property_status_idx').on(t.propertyId, t.status, t.createdAt)]);

/** An immutable committed response, or a terminal fence for an abandoned request. */
export const rateMutationFences = pgTable('rate_mutation_fences', {
  propertyId: uuid('property_id').notNull().references(() => properties.id),
  requestId: uuid('request_id').notNull(),
  fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
  actorKey: varchar('actor_key', { length: 255 }).notNull(),
  status: varchar('status', { length: 20 }).notNull(),
  response: jsonb('response'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.propertyId, t.requestId] })]);
