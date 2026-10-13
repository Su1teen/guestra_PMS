import { pgTable, uuid, text, jsonb, timestamp, primaryKey, boolean } from 'drizzle-orm/pg-core';
import { properties } from '@telivityhaip/database';
export const integrationDeployment=pgTable('guestra_integration_deployment',{
  id:boolean('id').primaryKey().default(true),environment:text('environment').notNull(),deploymentId:text('deployment_id').notNull(),
});
export const sandboxProperties=pgTable('guestra_sandbox_properties',{
 propertyId:uuid('property_id').primaryKey().references(()=>properties.id),tenantId:text('tenant_id').notNull(),
 roomTypeId:uuid('room_type_id').notNull(),ratePlanId:uuid('rate_plan_id').notNull(),serviceId:uuid('service_id'),
});
export const sandboxFixtures=pgTable('guestra_sandbox_fixtures',{
 propertyId:uuid('property_id').notNull().references(()=>properties.id),key:text('fixture_key').notNull(),
 fingerprint:text('fingerprint').notNull(),customerId:text('customer_id').notNull(),stage:text('stage').notNull(),
 refs:jsonb('refs').$type<Record<string,string>>().notNull(),expiresAt:timestamp('expires_at',{withTimezone:true}).notNull(),
 retiredAt:timestamp('retired_at',{withTimezone:true}),
 simulatedPayment:jsonb('simulated_payment').$type<Record<string,unknown>>(),
},t=>[primaryKey({columns:[t.propertyId,t.key]})]);

/** PMS-local receipts; CRM and Studio IDs are opaque strings. */
export const connectOperations = pgTable('connect_operations_v2', {
  propertyId: uuid('property_id').notNull().references(() => properties.id),
  key: text('operation_key').notNull(),
  customerId: text('customer_id').notNull(),
  fingerprint: text('fingerprint').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id').notNull(),
  result: jsonb('result').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
}, t => [primaryKey({columns: [t.propertyId, t.key]})]);
