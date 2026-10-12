import {
  Injectable,
  Inject,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, desc } from "drizzle-orm";
import {
  managementInputs,
  properties,
  auditLogs,
} from "@telivityhaip/database";
import {
  MANAGEMENT_REVENUE_ARTICLES,
  MANAGEMENT_EXPENSE_ARTICLES,
  type ManagementEntry,
} from "@telivityhaip/shared";
import { DRIZZLE } from "../../database/database.module";
import { actorFields, type AuditActor } from "../../common/audit/audit-actor";
import { reportDates, reportDate } from "./reporting-policy";

export interface ManagementInputCommand {
  propertyId: string;
  startDate: string;
  endDate: string;
  kind: "budget" | "expenses";
  expectedRevision: number;
  currencyCode: string;
  entries: ManagementEntry[];
  reason: string;
  coverageThrough?: string;
}
@Injectable()
export class ManagementInputsService {
  constructor(@Inject(DRIZZLE) private readonly db: any) {}
  async history(propertyId: string, startDate: string, endDate: string) {
    reportDates(startDate, endDate);
    return this.db
      .select()
      .from(managementInputs)
      .where(
        and(
          eq(managementInputs.propertyId, propertyId),
          eq(managementInputs.startDate, startDate),
          eq(managementInputs.endDate, endDate),
        ),
      )
      .orderBy(desc(managementInputs.createdAt));
  }
  async save(command: ManagementInputCommand, actor?: AuditActor) {
    const c = command;
    reportDates(c.startDate, c.endDate);
    if (
      !["budget", "expenses"].includes(c.kind) ||
      !Number.isInteger(c.expectedRevision) ||
      c.expectedRevision < 0 ||
      !c.reason?.trim() ||
      c.reason.length > 1000 ||
      !Array.isArray(c.entries) ||
      c.entries.length > 5000
    )
      throw new BadRequestException(
        "Некорректная версия или состав управленческих данных",
      );
    if (
      c.coverageThrough &&
      (reportDate(c.coverageThrough) < c.startDate ||
        c.coverageThrough > c.endDate)
    )
      throw new BadRequestException("Дата подтверждения вне периода");
    const articles: readonly string[] =
      c.kind === "budget"
        ? [...MANAGEMENT_REVENUE_ARTICLES, ...MANAGEMENT_EXPENSE_ARTICLES]
        : MANAGEMENT_EXPENSE_ARTICLES;
    const keys = new Set<string>();
    const entries = c.entries.map((e) => {
      if (
        !e ||
        reportDate(e.date) < c.startDate ||
        e.date > c.endDate ||
        !articles.includes(e.article) ||
        typeof e.amount !== "string" ||
        !/^-?\d{1,10}(\.\d{1,2})?$/.test(e.amount) ||
        (c.kind === "budget" && Number(e.amount) < 0)
      )
        throw new BadRequestException("Проверьте дату, статью и сумму строки");
      const key = `${e.date}:${e.article}`;
      if (keys.has(key)) throw new BadRequestException("Повтор даты и статьи");
      keys.add(key);
      return { date: e.date, article: e.article, amount: e.amount };
    });
    return this.db.transaction(async (tx: any) => {
      // Serialize versions across sessions without a new lock infrastructure.
      const [property] = await tx
        .select()
        .from(properties)
        .where(eq(properties.id, c.propertyId))
        .for("update");
      if (!property) throw new NotFoundException("Объект не найден");
      if (property.currencyCode !== c.currencyCode)
        throw new BadRequestException("Валюта не совпадает с валютой объекта");
      const [previous] = await tx
        .select()
        .from(managementInputs)
        .where(
          and(
            eq(managementInputs.propertyId, c.propertyId),
            eq(managementInputs.startDate, c.startDate),
            eq(managementInputs.endDate, c.endDate),
            eq(managementInputs.kind, c.kind),
          ),
        )
        .orderBy(desc(managementInputs.revision))
        .limit(1);
      if ((previous?.revision ?? 0) !== c.expectedRevision)
        throw new ConflictException({
          code: "MANAGEMENT_INPUT_CONFLICT",
          message:
            "Данные изменены другим сотрудником. Загрузите актуальную версию.",
        });
      const [next] = await tx
        .insert(managementInputs)
        .values({
          propertyId: c.propertyId,
          startDate: c.startDate,
          endDate: c.endDate,
          kind: c.kind,
          revision: c.expectedRevision + 1,
          currencyCode: c.currencyCode,
          entries,
          coverageThrough: c.coverageThrough ?? null,
          reason: c.reason.trim(),
        })
        .returning();
      await tx
        .insert(auditLogs)
        .values({
          propertyId: c.propertyId,
          entityType: "management_input",
          entityId: next.id,
          action: "create",
          previousValue: previous ?? null,
          newValue: next,
          description: c.reason.trim(),
          ...actorFields(actor),
        });
      return next;
    });
  }
}
