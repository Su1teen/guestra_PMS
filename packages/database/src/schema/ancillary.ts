import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  numeric,
  integer,
  date,
  jsonb,
  pgEnum,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { properties } from './property.js';
import { ratePlans } from './rate-plan.js';
import { reservations } from './reservation.js';
import { guests } from './guest.js';
import { folios } from './folio.js';
import { chargeTypeEnum } from './folio.js';

/**
 * Sellable stay extras (breakfast, parking, spa, late checkout, …).
 * Property-scoped. Distinct from house-account `products` (walk-in retail).
 */
export const servicePostingRuleEnum = pgEnum('service_posting_rule', [
  'once',
  'per_night',
  'on_consumption',
  'included_in_rate',
]);

export const reservationServiceStatusEnum = pgEnum('reservation_service_status', [
  'quoted',
  'confirmed',
  'posted',
  'cancelled',
]);

export const serviceAgentBookingModeEnum = pgEnum('service_agent_booking_mode', [
  'live_booking', 'request_only', 'info_only', 'disabled',
]);

export const serviceBookingStatusEnum = pgEnum('service_booking_status', [
  'scheduled', 'completed', 'cancelled',
]);

export const services = pgTable(
  'services',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id),

    code: varchar('code', { length: 40 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),

    chargeType: chargeTypeEnum('charge_type').notNull().default('incidental'),
    price: numeric('price', { precision: 12, scale: 2 }).notNull(),
    currencyCode: varchar('currency_code', { length: 3 }).notNull(),
    taxCode: varchar('tax_code', { length: 20 }),

    postingRule: servicePostingRuleEnum('posting_rule').notNull().default('once'),
    /** Channels that may sell this service: booking_engine | front_desk | pre_arrival */
    sellChannels: jsonb('sell_channels').$type<string[]>().notNull().default([]),
    agentBookingMode: serviceAgentBookingModeEnum('agent_booking_mode').notNull().default('disabled'),
    durationMinutes: integer('duration_minutes'),

    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('services_property_idx').on(t.propertyId),
    index('services_property_code_idx').on(t.propertyId, t.code),
  ],
);

/** Operational, schedulable booking; unlike reservation_services it can be service-only. */
export const serviceBookings = pgTable('service_bookings', {
  id: uuid('id').primaryKey().defaultRandom(),
  propertyId: uuid('property_id').notNull().references(() => properties.id),
  guestId: uuid('guest_id').notNull().references(() => guests.id),
  serviceId: uuid('service_id').notNull().references(() => services.id),
  reservationId: uuid('reservation_id').references(() => reservations.id),
  folioId: uuid('folio_id').references(() => folios.id),
  status: serviceBookingStatusEnum('status').notNull().default('scheduled'),
  startAt: timestamp('start_at', { withTimezone: true }).notNull(),
  endAt: timestamp('end_at', { withTimezone: true }).notNull(),
  participants: integer('participants').notNull().default(1),
  quantity: integer('quantity').notNull().default(1),
  unitPrice: numeric('unit_price', { precision: 12, scale: 2 }).notNull(),
  totalAmount: numeric('total_amount', { precision: 12, scale: 2 }).notNull(),
  currencyCode: varchar('currency_code', { length: 3 }).notNull(),
  notes: text('notes'),
  sourceChannel: varchar('source_channel', { length: 40 }).notNull().default('front_desk'),
  idempotencyKey: varchar('idempotency_key', { length: 200 }),
  integrationContext: jsonb('integration_context').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('service_bookings_property_idempotency_unique').on(t.propertyId, t.idempotencyKey),
  index('service_bookings_property_service_time_idx').on(t.propertyId, t.serviceId, t.startAt),
  index('service_bookings_guest_idx').on(t.propertyId, t.guestId),
]);

/** A resource is an operational capacity unit. It is deliberately not exposed to guest agents. */
export const serviceResources = pgTable('service_resources', {
  id: uuid('id').primaryKey().defaultRandom(),
  propertyId: uuid('property_id').notNull().references(() => properties.id),
  serviceId: uuid('service_id').notNull().references(() => services.id),
  code: varchar('code', { length: 60 }).notNull(),
  name: varchar('name', { length: 120 }).notNull(),
  capacity: integer('capacity').notNull().default(1),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('service_resources_service_idx').on(t.propertyId, t.serviceId)]);

export const serviceResourceAllocations = pgTable('service_resource_allocations', {
  id: uuid('id').primaryKey().defaultRandom(),
  propertyId: uuid('property_id').notNull().references(() => properties.id),
  serviceBookingId: uuid('service_booking_id').notNull().references(() => serviceBookings.id),
  resourceId: uuid('resource_id').notNull().references(() => serviceResources.id),
  units: integer('units').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('service_resource_allocations_booking_resource_unique').on(t.serviceBookingId, t.resourceId),
  index('service_resource_allocations_resource_idx').on(t.propertyId, t.resourceId),
]);

/**
 * Links a rate plan (typically type=package) to catalog services.
 */
export const ratePlanComponents = pgTable(
  'rate_plan_components',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id),
    ratePlanId: uuid('rate_plan_id')
      .notNull()
      .references(() => ratePlans.id),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id),

    quantity: integer('quantity').notNull().default(1),
    /** When set, overrides the service catalog price for this component. */
    amountOverride: numeric('amount_override', { precision: 12, scale: 2 }),
    /** true = bundled in room rate (reporting line); false = guest-visible surcharge */
    includedInRate: boolean('included_in_rate').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('rate_plan_components_property_idx').on(t.propertyId),
    index('rate_plan_components_rate_plan_idx').on(t.propertyId, t.ratePlanId),
  ],
);

/**
 * Services selected for a stay (upsell / package / front-desk attach).
 */
export const reservationServices = pgTable(
  'reservation_services',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id),
    reservationId: uuid('reservation_id')
      .notNull()
      .references(() => reservations.id),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id),

    quantity: integer('quantity').notNull().default(1),
    unitPrice: numeric('unit_price', { precision: 12, scale: 2 }).notNull(),
    currencyCode: varchar('currency_code', { length: 3 }).notNull(),

    /** Inclusive start (YYYY-MM-DD); null = use reservation stay dates */
    startDate: date('start_date'),
    endDate: date('end_date'),

    status: reservationServiceStatusEnum('status').notNull().default('confirmed'),
    sourceChannel: varchar('source_channel', { length: 40 }).notNull().default('front_desk'),
    postingRule: servicePostingRuleEnum('posting_rule').notNull(),
    chargeType: chargeTypeEnum('charge_type').notNull(),

    notes: text('notes'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('reservation_services_property_idx').on(t.propertyId),
    index('reservation_services_reservation_idx').on(t.propertyId, t.reservationId),
  ],
);
