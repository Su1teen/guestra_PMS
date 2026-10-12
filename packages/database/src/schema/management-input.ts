import {
  pgTable,
  uuid,
  varchar,
  date,
  integer,
  jsonb,
  timestamp,
  text,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { properties } from "./property.js";
import type { ManagementEntry } from "@telivityhaip/shared";
/** Immutable, explicitly supplied management inputs. Never post into guest folios. */
export const managementInputs = pgTable(
  "management_inputs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    kind: varchar("kind", { length: 16 }).notNull(),
    revision: integer("revision").notNull(),
    currencyCode: varchar("currency_code", { length: 3 }).notNull(),
    entries: jsonb("entries").$type<ManagementEntry[]>().notNull(),
    coverageThrough: date("coverage_through"),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    kind: check("management_inputs_kind_check", sql`${t.kind} in ('budget','expenses')`),
    revision: check("management_inputs_revision_check", sql`${t.revision} > 0`),
    entries: check("management_inputs_entries_check", sql`jsonb_typeof(${t.entries}) = 'array'`),
    period: check("management_inputs_check", sql`${t.endDate} >= ${t.startDate}`),
    coverage: check("management_inputs_check1", sql`${t.coverageThrough} is null or ${t.coverageThrough} between ${t.startDate} and ${t.endDate}`),
    version: uniqueIndex("management_inputs_version_unique").on(
      t.propertyId,
      t.startDate,
      t.endDate,
      t.kind,
      t.revision,
    ),
  }),
);
