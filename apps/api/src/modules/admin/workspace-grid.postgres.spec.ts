import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { properties, users } from "@telivityhaip/database";
import {
  workspaceTemplate,
  isWorkspaceLayout,
  normalizeWorkspace,
} from "@telivityhaip/shared";
import { UsersService } from "./users.service";
describe.runIf(process.env.PMS_LIVE_PG === "1")(
  "Workspace cross-session persistence on PostgreSQL",
  () => {
    const sql = postgres(process.env.DATABASE_URL!, { max: 4 }),
      db = drizzle(sql),
      propertyId = randomUUID(),
      userId = randomUUID();
    const first = new UsersService(db, {} as any),
      second = new UsersService(db, {} as any);
    const current = workspaceTemplate("management");
    const legacy = {
      version: 2,
      startPageId: "desk",
      pages: [
        {
          id: "desk",
          name: "Сохранённый стол",
          preset: "frontdesk",
          widgets: [
            {
              id: "arrivals",
              type: "arrivals",
              width: 2,
              height: 1,
              settings: { period: "next7", density: "compact" },
            },
          ],
        },
      ],
    };
    beforeAll(async () => {
      await db
        .insert(properties)
        .values({
          id: propertyId,
          name: "Workspace fixture",
          code: propertyId.slice(0, 16),
          countryCode: "KZ",
          timezone: "UTC",
          currencyCode: "KZT",
          totalRooms: 0,
        });
      await db
        .insert(users)
        .values({
          id: userId,
          propertyId,
          email: userId + "@example.test",
          name: "Synthetic workspace",
          preferences: {
            reportFavorites: ["daily-revenue"],
            workspaces: {
              [propertyId]: { revision: 3, layout: legacy },
              other: { revision: 5, layout: current as any },
            },
          },
        });
    });
    afterAll(async () => {
      await db.delete(users).where(eq(users.id, userId));
      await db.delete(properties).where(eq(properties.id, propertyId));
      await sql.end();
    });
    it("does not rewrite stored legacy data on read, then saves v3 pages, geometry and settings explicitly", async () => {
      const loaded = await first.getWorkspace(userId, propertyId);
      expect(loaded.layout).toEqual(legacy);
      expect((await second.getWorkspace(userId, propertyId)).revision).toBe(3);
      expect(isWorkspaceLayout(loaded.layout)).toBe(true);
      const migrated = normalizeWorkspace(loaded.layout as any);
      migrated.pages.push(
        workspaceTemplate("operations", "ops", "Операции").pages[0]!,
      );
      await first.updateWorkspace(userId, {
        propertyId,
        expectedRevision: 3,
        layout: migrated as any,
      });
      const crossDevice = await second.getWorkspace(userId, propertyId);
      expect(crossDevice.layout).toEqual(migrated);
      expect(crossDevice.revision).toBe(4);
      const preferences = await second.getPreferences(userId);
      expect(preferences.reportFavorites).toEqual(["daily-revenue"]);
      expect(preferences.workspaces?.other.revision).toBe(5);
    });
    it("accepts only one concurrent writer and leaves the other version available to reload", async () => {
      const revision = (await first.getWorkspace(userId, propertyId)).revision;
      const results = await Promise.allSettled([
        first.updateWorkspace(userId, {
          propertyId,
          expectedRevision: revision,
          layout: workspaceTemplate("frontdesk") as any,
        }),
        second.updateWorkspace(userId, {
          propertyId,
          expectedRevision: revision,
          layout: workspaceTemplate("revenue") as any,
        }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(
        (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
          .reason.response.code,
      ).toBe("WORKSPACE_CONFLICT");
      expect((await second.getWorkspace(userId, propertyId)).revision).toBe(
        revision + 1,
      );
    });
  },
);
