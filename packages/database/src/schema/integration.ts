import { pgTable, uuid, varchar, timestamp, jsonb, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { properties } from './property.js';

/** Durable external-to-PMS identity links; never resolve cross-system objects by display name. */
export const integrationLinks = pgTable('integration_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  propertyId: uuid('property_id').notNull().references(() => properties.id),
  sourceSystem: varchar('source_system', { length: 60 }).notNull(),
  externalEntityType: varchar('external_entity_type', { length: 80 }).notNull(),
  externalEntityId: varchar('external_entity_id', { length: 200 }).notNull(),
  localEntityType: varchar('local_entity_type', { length: 80 }).notNull(),
  localEntityId: uuid('local_entity_id').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('integration_links_external_unique').on(t.propertyId, t.sourceSystem, t.externalEntityType, t.externalEntityId),
  index('integration_links_local_idx').on(t.propertyId, t.sourceSystem, t.localEntityType, t.localEntityId),
  index('integration_links_property_local_idx').on(t.propertyId, t.localEntityType, t.localEntityId),
]);
