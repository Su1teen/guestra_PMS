import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray } from "drizzle-orm";
import {
  properties,
  guests,
  folios,
  charges,
  managementInputs,
  auditLogs,
  auditRuns,
} from "@telivityhaip/database";
import { ReportsService } from "./reports.service";
import { ManagementInputsService } from "./management-inputs.service";
import { ReportsController } from "./reports.controller";
import { PERMISSIONS_KEY } from "../auth/permissions.decorator";
import { Test } from "@nestjs/testing";
import { ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import request from "supertest";
import { PortfolioPropertyResolver } from "./portfolio-property-resolver";
import { PropertyScopeGuard } from "../auth/property-scope.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import { PermissionsService } from "../auth/permissions.service";

describe.runIf(process.env.PMS_LIVE_PG === "1")(
  "Management signed ledger and versioned inputs on PostgreSQL",
  () => {
    const sql = postgres(process.env.DATABASE_URL!, { max: 8 }),
      db = drizzle(sql),
      reports = new ReportsService(db),
      inputs = new ManagementInputsService(db);
    const a = randomUUID(),
      b = randomUUID(),
      guest = randomUUID(),
      folio = randomUUID(),
      foreign = randomUUID();
    const start = "2024-02-01",
      end = "2024-02-29",
      cutoff = "2024-02-29";
    beforeAll(async () => {
      await db.insert(properties).values([
        {
          id: a,
          name: "Management A",
          code: a.slice(0, 16),
          countryCode: "KZ",
          currencyCode: "KZT",
          timezone: "Asia/Almaty",
          totalRooms: 0,
        },
        {
          id: b,
          name: "Management B",
          code: b.slice(0, 16),
          countryCode: "US",
          currencyCode: "USD",
          timezone: "UTC",
          totalRooms: 0,
        },
      ]);
      await db
        .insert(guests)
        .values({ id: guest, firstName: "Synthetic", lastName: "Management" });
      await db.insert(folios).values([
        {
          id: folio,
          propertyId: a,
          guestId: guest,
          folioNumber: "M3-A",
          currencyCode: "KZT",
        },
        {
          id: foreign,
          propertyId: b,
          guestId: guest,
          folioNumber: "M3-B",
          currencyCode: "USD",
        },
      ]);
    });
    beforeEach(async () => {
      for (const table of [charges, managementInputs, auditLogs, auditRuns])
        await db.delete(table).where(inArray(table.propertyId, [a, b]));
    });
    afterAll(async () => {
      for (const table of [
        charges,
        managementInputs,
        auditLogs,
        auditRuns,
        folios,
      ])
        await db.delete(table).where(inArray(table.propertyId, [a, b]));
      await db.delete(guests).where(eq(guests.id, guest));
      await db.delete(properties).where(inArray(properties.id, [a, b]));
      await sql.end();
    });
    const post = async (
      amount: string,
      type: "room" | "tax" | "spa" | "food_beverage" | "adjustment" = "room",
      extra: any = {},
    ) =>
      (
        await db
          .insert(charges)
          .values({
            propertyId: a,
            folioId: folio,
            type,
            description: "Synthetic management",
            amount,
            currencyCode: "KZT",
            serviceDate: new Date("2024-02-29T00:00:00Z"),
            ...extra,
          })
          .returning()
      )[0]!;
    const command = (kind: "budget" | "expenses" = "budget") => ({
      propertyId: a,
      startDate: start,
      endDate: end,
      kind,
      currencyCode: "KZT",
      expectedRevision: 0,
      entries: [
        {
          date: cutoff,
          article: kind === "budget" ? "room" : "operations",
          amount: "80",
        },
      ],
      reason: "Approved synthetic source",
    });
    it("reconciles hierarchy, DRR and trend with service-only revenue, tax and signed reversal; excludes deposit credit", async () => {
      const original = await post("100");
      await post("-20", "room", {
        isReversal: true,
        originalChargeId: original.id,
      });
      await post("30", "spa", { folioId: null });
      await post("40", "food_beverage");
      await post("15", "tax");
      await post("-50", "adjustment", {
        revenueRole: "deposit_credit",
        sourceKey: "deposit:" + randomUUID(),
      });
      await db
        .insert(charges)
        .values({
          propertyId: b,
          folioId: foreign,
          type: "room",
          description: "Foreign",
          amount: "999",
          currencyCode: "USD",
          serviceDate: new Date("2024-02-29T00:00:00Z"),
        });
      const [management, drr, trend] = await Promise.all([
        reports.getManagementReport(a, start, end, cutoff),
        reports.getDailyRevenue(a, cutoff),
        reports.getOccupancyTrend(a, start, end),
      ]);
      expect(management.totals.revenue.actual).toBe(150);
      expect(management.totals.revenue.actual).toBe(drr.netEarnedRevenue);
      expect(trend.actual.value).toBe(150);
      expect(
        management.revenueRows[0]?.children?.map((r) => r.metrics.actual),
      ).toEqual([80, 40, 30]);
      expect(management.sources).toMatchObject({
        budget: "NOT_CONFIGURED",
        expenses: "NOT_CONFIGURED",
        forecast: "INSUFFICIENT_HISTORY",
      });
      expect(management.totals.operatingResult).toBeNull();
      const operations = await reports.getManagementOperations(
        a,
        start,
        end,
        "room",
      );
      expect(operations.map((r) => r.amount).sort()).toEqual([
        "-20.00",
        "100.00",
      ]);
    });
    it("clamps leap-year LYTD and preserves missing source states instead of fabricated zero revenue", async () => {
      const r = await reports.getManagementReport(a, start, end, cutoff);
      expect(r.period.lyEnd).toBe("2023-02-28");
      expect(r.period.lyCutoff).toBe("2023-02-28");
      expect(r.totals.revenue.actual).toBeNull();
      expect(r.totals.revenue.ly).toBeNull();
      expect(r.totals.revenue.plan).toBeNull();
      await db.insert(auditRuns).values({propertyId:a,businessDate:start,status:"completed"});
      const closed = await reports.getManagementReport(a,start,end,cutoff);
      expect(closed.daily[0].actual).toBe(0);
      expect(closed.daily[1].actual).toBeNull();
      await inputs.save({...command("expenses"),entries:[]});
      const unconfirmed = await reports.getManagementReport(a,start,end,cutoff);
      expect(unconfirmed.totals.expenses.actual).toBeNull();
      expect(unconfirmed.daily[0].expenses).toBeNull();
    });
    it("uses explicit daily budgets, uncapped attainment and negative remaining; exposes separate to-date variance", async () => {
      await post("120");
      await inputs.save({
        ...command(),
        entries: [
          { date: start, article: "room", amount: "20" },
          { date: cutoff, article: "room", amount: "80" },
        ],
      });
      const r = await reports.getManagementReport(a, start, end, cutoff);
      expect(r.totals.revenue).toMatchObject({
        actual: 120,
        plan: 100,
        planToDate: 100,
        attainment: 120,
        remaining: -20,
        toDateVariance: 20,
      });
      expect(r.inputs.budget?.revision).toBe(1);
      const earlier = await reports.getManagementReport(
        a,
        start,
        end,
        "2024-02-15",
      );
      expect(earlier.totals.revenue.planToDate).toBe(20);
    });
    it("allows operating result only after full audit coverage and explicitly confirmed expense coverage", async () => {
      await post("120");
      await inputs.save({ ...command("expenses"), coverageThrough: cutoff });
      expect(
        (await reports.getManagementReport(a, start, end, cutoff)).totals
          .operatingResult,
      ).toBeNull();
      await db
        .insert(auditRuns)
        .values(
          Array.from({ length: 29 }, (_, i) => ({
            propertyId: a,
            businessDate: `2024-02-${String(i + 1).padStart(2, "0")}`,
            status: "completed" as const,
          })),
        );
      expect(
        (await reports.getManagementReport(a, start, end, cutoff)).totals
          .operatingResult,
      ).toBe(40);
    });
    it("serializes concurrent versions, preserves immutable history and audit; rejects foreign currency", async () => {
      const results = await Promise.allSettled([
        inputs.save(command()),
        inputs.save({ ...command(), reason: "Concurrent source" }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find(
        (r) => r.status === "rejected",
      ) as PromiseRejectedResult;
      expect(rejected.reason.status).toBe(409);
      await inputs.save({
        ...command(),
        expectedRevision: 1,
        reason: "Revision two",
      });
      expect(await inputs.history(a, start, end)).toHaveLength(2);
      expect(await inputs.history(b, start, end)).toHaveLength(0);
      expect(
        await db.select().from(auditLogs).where(eq(auditLogs.propertyId, a)),
      ).toHaveLength(2);
      await expect(
        inputs.save({ ...command(), propertyId: b }),
      ).rejects.toMatchObject({ status: 400 });
    });
    it("rolls back published version when audit insertion fails", async () => {
      await expect(
        inputs.save(command(), {
          userId: null,
          userEmail: "x".repeat(256),
          ipAddress: null,
        }),
      ).rejects.toThrow();
      expect(await inputs.history(a, start, end)).toHaveLength(0);
    });
    it("rejects duplicate daily articles and invalid dates before writes", async () => {
      const c = command();
      await expect(
        inputs.save({ ...c, entries: [...c.entries, ...c.entries] }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        inputs.save({ ...c, startDate: "2024-02-30" }),
      ).rejects.toMatchObject({ status: 400 });
      expect(await inputs.history(a, start, end)).toHaveLength(0);
    });
    it("requires read, management and accounting rights for budget mutation; drills require folio access", () => {
      expect(
        Reflect.getMetadata(
          PERMISSIONS_KEY,
          ReportsController.prototype.publishManagementInputs,
        ),
      ).toEqual([
        "reports.view",
        "management_dashboard.view",
        "accounting.manage",
      ]);
      expect(
        Reflect.getMetadata(
          PERMISSIONS_KEY,
          ReportsController.prototype.managementOperations,
        ),
      ).toContain("folios.read");
    });
    it("serves the actual report over HTTP, enforces tenant/RBAC and rejects stale or malformed writes", async () => {
      await post("123.45");
      const grants = [
        "reports.view",
        "management_dashboard.view",
        "folios.read",
      ];
      const module = await Test.createTestingModule({
        controllers: [ReportsController],
        providers: [
          PropertyScopeGuard,
          PermissionsGuard,
          { provide: ReportsService, useValue: reports },
          { provide: ManagementInputsService, useValue: inputs },
          { provide: PortfolioPropertyResolver, useValue: {} },
          { provide: ConfigService, useValue: { get: () => "true" } },
          {
            provide: PermissionsService,
            useValue: {
              findLocalUser: async () => ({ id: guest }),
              getEffectivePermissions: async () => grants,
            },
          },
        ],
      }).compile();
      const app = module.createNestApplication();
      app.setGlobalPrefix("api/v1");
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
        }),
      );
      // Synthetic local principal exercises authorization guards; this is not a Keycloak/JWT claim.
      app.use((req: any, _res: any, next: () => void) => {
        req.user = {
          sub: guest,
          email: "synthetic@example.test",
          roles: [],
          propertyIds: [a],
        };
        next();
      });
      app.useGlobalGuards(
        module.get(PropertyScopeGuard),
        module.get(PermissionsGuard),
      );
      await app.init();
      try {
        const response = await request(app.getHttpServer())
          .get("/api/v1/reports/management-report")
          .query({
            propertyId: a,
            startDate: start,
            endDate: end,
            date: cutoff,
          })
          .expect(200);
        expect(response.body.totals.revenue.actual).toBe(123.45);
        const drill = await request(app.getHttpServer())
          .get("/api/v1/reports/management-operations")
          .query({ propertyId: a, startDate: start, endDate: cutoff, article: "room", offset: "0" })
          .expect(200);
        expect(drill.body.map((o: any) => o.amount)).toEqual(["123.45"]);
        await request(app.getHttpServer())
          .get("/api/v1/reports/management-operations")
          .query({ propertyId: a, startDate: start, endDate: cutoff, article: "tax" })
          .expect(400);
        await request(app.getHttpServer())
          .get("/api/v1/reports/management-report")
          .query({ propertyId: b, startDate: start, endDate: end })
          .expect(403);
        await request(app.getHttpServer())
          .post("/api/v1/reports/management-inputs")
          .send(command())
          .expect(403);
        grants.push("accounting.manage");
        await request(app.getHttpServer())
          .post("/api/v1/reports/management-inputs")
          .send(command())
          .expect(201);
        await request(app.getHttpServer())
          .post("/api/v1/reports/management-inputs")
          .send(command())
          .expect(409);
        await request(app.getHttpServer())
          .post("/api/v1/reports/management-inputs")
          .send({
            ...command(),
            expectedRevision: 1,
            entries: [{ date: "invalid", article: "room", amount: "1" }],
          })
          .expect(400);
        const after = await reports.getManagementReport(a, start, end, cutoff);
        expect(after.inputs.budget?.revision).toBe(1);
        expect(after.totals.revenue.actual).toBe(
          response.body.totals.revenue.actual,
        );
      } finally {
        await app.close();
      }
    }, 20000);
  },
);
