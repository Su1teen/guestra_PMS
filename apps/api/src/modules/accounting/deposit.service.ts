import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { eq, and, sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { auditLogs, charges, depositLedgerEntries, folios, properties, reservations, payments } from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';
import { actorFields, type AuditActor } from '../../common/audit/audit-actor';
import { DomainEventOutboxService } from '../webhook/domain-event-outbox.service';
import { FolioService } from '../folio/folio.service';
import { RecordDepositDto } from './dto/record-deposit.dto';
import { ListDepositsDto } from './dto/list-deposits.dto';
import { ApplyDepositDto } from './dto/apply-deposit.dto';

/**
 * Deposit Ledger service (KB 10).
 *
 * Advance deposits are a LIABILITY, not revenue (KB 10.1). A deposit is created
 * in the `held` state and is only recognized when applied to a folio (check-in /
 * checkout — KB 10.3) or forfeited as earned revenue (non-refundable cancel /
 * no-show — KB 10.4). Refundable deposits may be refunded while still held.
 *
 * State machine (KB 10.3/10.4): only a `held` deposit may transition to
 * `applied`, `refunded`, or `forfeited`. Those are terminal.
 */
@Injectable()
export class DepositService {
  constructor(
    @Inject(DRIZZLE) private readonly db: any,
    private readonly outbox: DomainEventOutboxService,
    private readonly folioService: FolioService,
  ) {}

  private async persist(tx: any, entry: typeof depositLedgerEntries.$inferSelect, action: string,
    actor?: AuditActor, details: Record<string, unknown> = {}) {
    await tx.insert(auditLogs).values({ propertyId: entry.propertyId, action: action === 'received' ? 'create' : 'update',
      entityType: 'deposit', entityId: entry.id, description: `Deposit ${action}`,
      newValue: { status: entry.status, amount: entry.amount, ...details }, ...actorFields(actor) });
    await this.outbox.persist(tx, { event: `deposit.${action}` as any, entityType: 'deposit', entityId: entry.id,
      propertyId: entry.propertyId, data: { status: entry.status, amount: entry.amount, ...details },
      timestamp: new Date().toISOString() }, `deposit:${entry.id}:${action}`);
  }

  private async persistCharge(tx: any, charge: any, actor?: AuditActor) {
    await tx.insert(auditLogs).values({ propertyId: charge.propertyId, action: 'create', entityType: 'charge',
      entityId: charge.id, description: 'Deposit ledger charge', newValue: { type: charge.type, amount: charge.amount,
        sourceKey: charge.sourceKey, revenueRole: charge.revenueRole }, ...actorFields(actor) });
    await this.outbox.persist(tx, { event: 'folio.charge_posted', entityType: 'charge', entityId: charge.id,
      propertyId: charge.propertyId, data: { folioId: charge.folioId ?? null, type: charge.type,
        amount: charge.amount, description: charge.description }, timestamp: new Date().toISOString() },
    `charge:${charge.id}:posted`);
  }

  private async lockDeposit(tx: any, id: string, propertyId: string) {
    const scope = and(eq(depositLedgerEntries.id, id), eq(depositLedgerEntries.propertyId, propertyId));
    const [candidate] = await tx.select({ reservationId: depositLedgerEntries.reservationId })
      .from(depositLedgerEntries).where(scope);
    if (!candidate) throw new NotFoundException(`Deposit ${id} not found`);
    if (candidate.reservationId) {
      const [reservation] = await tx.select({ id: reservations.id }).from(reservations)
        .where(and(eq(reservations.id, candidate.reservationId), eq(reservations.propertyId, propertyId))).for('update');
      if (!reservation) throw new BadRequestException('Deposit reservation not found in property');
    }
    const [entry] = await tx.select().from(depositLedgerEntries).where(scope).for('update');
    if (!entry) throw new NotFoundException(`Deposit ${id} not found`);
    return entry;
  }

  async recordDeposit(dto: RecordDepositDto, actor?: AuditActor) {
    // FK ownership (security audit follow-on): caller-supplied reservationId
    // and paymentId must belong to dto.propertyId. Schema FK only constrains
    // the row id, so without this a deposit could be attached cross-tenant.
    if (dto.reservationId) {
      const [r] = await this.db
        .select({ id: reservations.id })
        .from(reservations)
        .where(and(eq(reservations.id, dto.reservationId), eq(reservations.propertyId, dto.propertyId)));
      if (!r) throw new BadRequestException(`reservation ${dto.reservationId} not found in this property`);
    }
    if (dto.paymentId) {
      const [p] = await this.db
        .select({ id: payments.id })
        .from(payments)
        .where(and(eq(payments.id, dto.paymentId), eq(payments.propertyId, dto.propertyId)));
      if (!p) throw new BadRequestException(`payment ${dto.paymentId} not found in this property`);
    }
    const entry = await this.db.transaction(async (tx: any) => {
      const [property] = await tx.select({ currencyCode: properties.currencyCode }).from(properties).where(eq(properties.id, dto.propertyId));
      if (!property || property.currencyCode !== dto.currencyCode) throw new BadRequestException('Deposit currency must match property currency');
      const [created] = await tx.insert(depositLedgerEntries).values({
        propertyId: dto.propertyId,
        reservationId: dto.reservationId,
        paymentId: dto.paymentId,
        amount: new Decimal(dto.amount).toFixed(2),
        currencyCode: dto.currencyCode,
        status: 'held',
        isRefundable: dto.isRefundable ?? true,
        notes: dto.notes,
      }).returning();
      await this.persist(tx, created, 'received', actor, { isRefundable: created.isRefundable });
      return created;
    });
    await this.outbox.deliver(dto.propertyId, `deposit:${entry.id}:received`);
    return entry;
  }

  async findById(id: string, propertyId: string) {
    const [entry] = await this.db
      .select()
      .from(depositLedgerEntries)
      .where(
        and(eq(depositLedgerEntries.id, id), eq(depositLedgerEntries.propertyId, propertyId)),
      );
    if (!entry) {
      throw new NotFoundException(`Deposit ${id} not found`);
    }
    return entry;
  }

  async list(dto: ListDepositsDto) {
    const conditions: any[] = [eq(depositLedgerEntries.propertyId, dto.propertyId)];
    if (dto.reservationId) {
      conditions.push(eq(depositLedgerEntries.reservationId, dto.reservationId));
    }
    if (dto.status) {
      conditions.push(
        eq(depositLedgerEntries.status, dto.status as 'held' | 'applied' | 'refunded' | 'forfeited'),
      );
    }

    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const offset = (page - 1) * limit;
    const whereClause = and(...conditions);

    const [data, countResult] = await Promise.all([
      this.db
        .select()
        .from(depositLedgerEntries)
        .where(whereClause)
        .limit(limit)
        .offset(offset)
        .orderBy(depositLedgerEntries.createdAt),
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(depositLedgerEntries)
        .where(whereClause),
    ]);

    return {
      data,
      total: Number(countResult[0]?.count ?? 0),
      page,
      limit,
    };
  }

  /**
   * Apply a held deposit to the reservation folio (KB 10.3). Posts a credit
   * (negative adjustment charge) to the folio, offsetting actual charges, then
   * marks the deposit `applied` and stamps `recognizedAt`.
   */
  async applyDeposit(id: string, dto: ApplyDepositDto, actor?: AuditActor, existingTx?: any) {
    const perform = async (tx: any) => {
      const entry = await this.lockDeposit(tx, id, dto.propertyId);
      if (entry.status === 'applied') {
        if (dto.folioId) {
          const [posted] = await tx.select({ folioId: charges.folioId }).from(charges).where(and(eq(charges.propertyId, dto.propertyId), eq(charges.sourceKey, `deposit:${id}:apply`)));
          if (posted?.folioId !== dto.folioId) throw new BadRequestException('Deposit already applied to another folio');
        }
        return entry;
      }
      if (entry.status !== 'held') throw new BadRequestException(`Only a held deposit can be applied (current: ${entry.status})`);
      let folioId = dto.folioId;
      if (!folioId && entry.reservationId) {
        const [found] = await tx.select({ id: folios.id }).from(folios).where(and(eq(folios.propertyId, dto.propertyId), eq(folios.reservationId, entry.reservationId), eq(folios.type, 'guest')));
        folioId = found?.id;
      }
      if (!folioId) throw new BadRequestException('An existing same-property reservation folio is required to apply a deposit');
      await tx.select({ id: folios.id }).from(folios).where(and(eq(folios.id, folioId), eq(folios.propertyId, dto.propertyId))).for('update');
      const folio = await this.folioService.findById(folioId, dto.propertyId, tx);
      if (folio.currencyCode !== entry.currencyCode || (entry.reservationId && folio.reservationId !== entry.reservationId)) {
        throw new BadRequestException('Deposit and folio must belong to the same reservation and currency');
      }
      const charge = await this.folioService.postCharge(folioId, { propertyId: dto.propertyId, type: 'adjustment',
        description: 'Deposit applied', amount: new Decimal(entry.amount).negated().toFixed(2),
        currencyCode: entry.currencyCode, serviceDate: new Date().toISOString(), skipTaxCalculation: true,
        postedBy: actor?.userId ?? undefined }, tx, { sourceKey: `deposit:${id}:apply`, revenueRole: 'deposit_credit' });
      await this.persistCharge(tx, charge, actor);
      const [updated] = await tx.update(depositLedgerEntries).set({ status: 'applied', recognizedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(depositLedgerEntries.id, id), eq(depositLedgerEntries.propertyId, dto.propertyId), eq(depositLedgerEntries.status, 'held'))).returning();
      await this.persist(tx, updated, 'applied', actor, { folioId });
      return updated;
    };
    const updated = existingTx ? await perform(existingTx) : await this.db.transaction(perform);
    if (!existingTx) await this.outbox.deliver(dto.propertyId, `deposit:${id}:applied`);
    return updated;
  }

  /**
   * Refund a held, refundable deposit (KB 10.4). Clears the liability.
   */
  async refundDeposit(id: string, propertyId: string, actor?: AuditActor, existingTx?: any) {
    const perform = async (tx: any) => {
      const entry = await this.lockDeposit(tx, id, propertyId);
      if (entry.status === 'refunded') return entry;
      if (entry.status !== 'held') throw new BadRequestException(`Only a held deposit can be refunded (current: ${entry.status})`);
      if (!entry.isRefundable) throw new BadRequestException('Deposit is non-refundable and cannot be refunded');
      const [updated] = await tx.update(depositLedgerEntries).set({ status: 'refunded', updatedAt: new Date() })
        .where(and(eq(depositLedgerEntries.id, id), eq(depositLedgerEntries.propertyId, propertyId), eq(depositLedgerEntries.status, 'held'))).returning();
      await this.persist(tx, updated, 'refunded', actor);
      return updated;
    };
    const updated = existingTx ? await perform(existingTx) : await this.db.transaction(perform);
    if (!existingTx) await this.outbox.deliver(propertyId, `deposit:${id}:refunded`);
    return updated;
  }

  /**
   * Forfeit a held deposit (non-refundable cancel / no-show), recognizing it as
   * earned revenue (KB 10.4).
   */
  async forfeitDeposit(id: string, propertyId: string, actor?: AuditActor, existingTx?: any) {
    const perform = async (tx: any) => {
      const entry = await this.lockDeposit(tx, id, propertyId);
      if (entry.status === 'forfeited') return entry;
      if (entry.status !== 'held') throw new BadRequestException(`Only a held deposit can be forfeited (current: ${entry.status})`);
      let offset = new Decimal(0);
      if (entry.reservationId) {
        const [folio] = await tx.select().from(folios).where(and(eq(folios.propertyId, propertyId), eq(folios.reservationId, entry.reservationId), eq(folios.type, 'guest'))).for('update');
        if (folio) {
          if (folio.currencyCode !== entry.currencyCode) throw new BadRequestException('Deposit and folio currency must match');
          const ledger = await tx.select().from(charges).where(and(eq(charges.propertyId, propertyId), eq(charges.folioId, folio.id), eq(charges.currencyCode, entry.currencyCode)));
          const fees = new Set(ledger.filter((row: any) => row.type === 'fee' && row.sourceKey?.startsWith(`settlement:${entry.reservationId}:`)).map((row: any) => row.id));
          const credits = new Set(ledger.filter((row: any) => row.revenueRole === 'deposit_credit'
            && row.sourceKey?.startsWith('deposit:') && row.sourceKey.endsWith(':forfeit-credit')).map((row: any) => row.id));
          const unallocated = ledger.filter((row: any) => fees.has(row.id) || credits.has(row.id)
            || (row.isReversal && (fees.has(row.originalChargeId) || credits.has(row.originalChargeId))))
            .reduce((sum: Decimal, row: any) => sum.plus(row.amount), new Decimal(0));
          offset = Decimal.min(new Decimal(entry.amount), Decimal.max(0, unallocated));
          if (offset.greaterThan(0)) {
            if (folio.status !== 'open') throw new BadRequestException('Open guest folio is required to settle a posted penalty');
            const credit = await this.folioService.postCharge(folio.id, { propertyId, type: 'adjustment',
            description: 'Forfeited deposit settled against penalty', amount: offset.negated().toFixed(2),
            currencyCode: entry.currencyCode, serviceDate: new Date().toISOString(), skipTaxCalculation: true,
            postedBy: actor?.userId ?? undefined }, tx, { sourceKey: `deposit:${id}:forfeit-credit`, revenueRole: 'deposit_credit' });
            await this.persistCharge(tx, credit, actor);
          }
        }
      }
      const residual = new Decimal(entry.amount).minus(offset);
      if (residual.greaterThan(0)) {
        const [forfeitureCharge] = await tx.insert(charges).values({ propertyId, type: 'fee',
        description: 'Deposit forfeited', amount: residual.toFixed(2), currencyCode: entry.currencyCode,
        serviceDate: new Date(), sourceKey: `deposit:${id}:forfeit`, postedBy: actor?.userId ?? undefined }).returning();
        await this.persistCharge(tx, forfeitureCharge, actor);
      }
      const [updated] = await tx.update(depositLedgerEntries).set({ status: 'forfeited', recognizedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(depositLedgerEntries.id, id), eq(depositLedgerEntries.propertyId, propertyId), eq(depositLedgerEntries.status, 'held'))).returning();
      await this.persist(tx, updated, 'forfeited', actor, { penaltyOffset: offset.toFixed(2), earnedFromForfeiture: residual.toFixed(2) });
      return updated;
    };
    const updated = existingTx ? await perform(existingTx) : await this.db.transaction(perform);
    if (!existingTx) await this.outbox.deliver(propertyId, `deposit:${id}:forfeited`);
    return updated;
  }
}
