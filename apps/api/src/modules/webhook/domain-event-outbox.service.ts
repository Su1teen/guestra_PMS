import { Inject, Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { and, asc, eq, isNull, lte } from 'drizzle-orm';
import { auditLogs, domainEventOutbox } from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';
import { WebhookService, type WebhookPayload } from './webhook.service';
@Injectable()
export class DomainEventOutboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DomainEventOutboxService.name);
  private scanning = false;
  private timer?: ReturnType<typeof setInterval>;
  constructor(@Inject(DRIZZLE) private readonly db: any, private readonly webhooks: WebhookService) {}
  onModuleInit() {
    if (process.env['NODE_ENV'] === 'test') return;
    this.timer = setInterval(() => { void this.recover(); }, 15000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  async persist(tx: any, payload: WebhookPayload, logicalEventId: string) {
    await tx.insert(domainEventOutbox).values({ propertyId: payload.propertyId, logicalEventId, payload }).onConflictDoNothing();
    await tx.insert(auditLogs).values({ propertyId: payload.propertyId, action: 'create', entityType: payload.entityType,
      entityId: payload.entityId, description: 'Webhook event: ' + payload.event, newValue: { ...payload, logicalEventId } });
  }
  /** At-least-once dispatch. Consumers deduplicate with the immutable logicalEventId. */
  async deliver(propertyId: string, logicalEventId: string) {
    return this.db.transaction(async (tx: any) => {
      const [row] = await tx.select().from(domainEventOutbox).where(and(eq(domainEventOutbox.propertyId, propertyId), eq(domainEventOutbox.logicalEventId, logicalEventId), isNull(domainEventOutbox.deliveredAt))).for('update', { skipLocked: true });
      if (!row) return;
      try {
        await this.webhooks.dispatchPersisted(row.payload as WebhookPayload, row.logicalEventId);
        await tx.update(domainEventOutbox).set({ deliveredAt: new Date(), attempts: row.attempts + 1 }).where(eq(domainEventOutbox.id, row.id));
      } catch {
        await tx.update(domainEventOutbox).set({ attempts: row.attempts + 1, availableAt: new Date(Date.now() + Math.min(300000, 15000 * 2 ** Math.min(row.attempts, 5))) }).where(eq(domainEventOutbox.id, row.id));
        this.logger.warn('Committed domain event retained for retry');
      }
    });
  }
  async recover() {
    if (this.scanning) return; this.scanning = true;
    try {
      const rows = await this.db.select({ propertyId: domainEventOutbox.propertyId, logicalEventId: domainEventOutbox.logicalEventId }).from(domainEventOutbox)
        .where(and(isNull(domainEventOutbox.deliveredAt), lte(domainEventOutbox.availableAt, new Date()))).orderBy(asc(domainEventOutbox.availableAt)).limit(20);
      for (const row of rows) await this.deliver(row.propertyId, row.logicalEventId);
    } catch { this.logger.warn('Domain event recovery is temporarily unavailable'); }
    finally { this.scanning = false; }
  }
}
