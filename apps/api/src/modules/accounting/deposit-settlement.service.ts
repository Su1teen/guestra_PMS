import { BadRequestException, Injectable, Inject, NotFoundException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { eq, and } from 'drizzle-orm';
import { auditLogs, charges, depositLedgerEntries, folios, reservations } from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';
import { actorFields, type AuditActor } from '../../common/audit/audit-actor';
import { DomainEventOutboxService } from '../webhook/domain-event-outbox.service';
import { DepositService } from './deposit.service';
import { FolioService } from '../folio/folio.service';
import type { CancellationEvaluation, DepositAction } from '../policy/policy.service';

export interface SettlementResult {
  penaltyPosted: boolean;
  penaltyAmount: string;
  deposits: Array<{ id: string; status: string; amount: string }>;
  policyDescription: string;
  withinFreeWindow: boolean;
}

/**
 * Shared cancel / no-show deposit settlement (KB §10.4) plus optional penalty posting.
 */
@Injectable()
export class DepositSettlementService {
  constructor(
    @Inject(DRIZZLE) private readonly db: any,
    private readonly depositService: DepositService,
    private readonly folioService: FolioService,
    private readonly outbox: DomainEventOutboxService,
  ) {}

  async listHeldDeposits(reservationId: string, propertyId: string, tx?: any) {
    return (tx ?? this.db)
      .select()
      .from(depositLedgerEntries)
      .where(
        and(
          eq(depositLedgerEntries.reservationId, reservationId),
          eq(depositLedgerEntries.propertyId, propertyId),
          eq(depositLedgerEntries.status, 'held'),
        ),
      );
  }

  /**
   * Apply all held deposits to the guest folio (KB §10.3 — check-in recognition).
   */
  async applyHeldDeposits(reservationId: string, propertyId: string, folioId: string) {
    const held = await this.listHeldDeposits(reservationId, propertyId);
    const applied: Array<{ id: string; amount: string }> = [];
    for (const entry of held) {
      const updated = await this.depositService.applyDeposit(entry.id, {
        propertyId,
        folioId,
      });
      applied.push({ id: updated.id, amount: updated.amount });
    }
    return applied;
  }

  /**
   * Settle deposits + post cancel/no-show penalty from a policy evaluation.
   */
  async settleFromEvaluation(params: {
    reservationId: string;
    propertyId: string;
    currencyCode: string;
    evaluation: CancellationEvaluation;
    /** When set, posts this fee description (e.g. Cancellation penalty / No-show fee). */
    penaltyDescription?: string;
    /** Extra additive fee (property noShowFeeAmount) on top of policy penalty. */
    additionalFeeAmount?: number | string | null;
    additionalFeeDescription?: string;
    actor?: AuditActor;
  }, transaction?: any): Promise<SettlementResult> {
    const {
      reservationId,
      propertyId,
      currencyCode,
      evaluation,
      penaltyDescription = 'Cancellation penalty',
      additionalFeeAmount,
      additionalFeeDescription = 'No-show fee',
      actor,
    } = params;
    const perform = async (tx: any) => {
      // Serializes fee identity and deposit allocation for simultaneous settlement retries.
      const [reservation] = await tx.select({ id: reservations.id, currencyCode: reservations.currencyCode }).from(reservations)
        .where(and(eq(reservations.id, reservationId), eq(reservations.propertyId, propertyId))).for('update');
      if (!reservation) throw new NotFoundException('Reservation not found in property');
      if (reservation.currencyCode !== currencyCode) throw new BadRequestException('Settlement currency must match reservation');
      let penaltyPosted = false;
      const needsFolio = Number(evaluation.penaltyAmount) > 0 || (additionalFeeAmount != null && Number(additionalFeeAmount) > 0);
      if (needsFolio) {
        const folio = await this.ensureGuestFolio(reservationId, propertyId, tx, actor);
        if (folio.currencyCode !== currencyCode) throw new BadRequestException('Settlement currency must match folio');
        const postFee = async (kind: 'policy' | 'additional', amount: string, description: string) => {
          const key = `settlement:${reservationId}:${kind}`;
          const [existing] = await tx.select().from(charges).where(and(eq(charges.propertyId, propertyId), eq(charges.folioId, folio.id), eq(charges.sourceKey, key)));
          if (existing) {
            if (!new Decimal(existing.amount).equals(amount) || existing.currencyCode !== currencyCode) throw new BadRequestException('Existing settlement fee differs from current policy');
            return false;
          }
          const charge = await this.folioService.postCharge(folio.id, { propertyId, type: 'fee', description, amount,
            currencyCode, serviceDate: new Date().toISOString(), postedBy: actor?.userId ?? undefined }, tx, { sourceKey: key });
          for (const posting of [charge, ...(charge.taxCharges ?? [])]) {
            await tx.insert(auditLogs).values({ propertyId, action: 'create', entityType: 'charge', entityId: posting.id,
              description: 'Cancellation/no-show policy posting', newValue: { sourceKey: posting.sourceKey, amount: posting.amount, currencyCode, parentChargeId: posting.parentChargeId }, ...actorFields(actor) });
            await this.outbox.persist(tx, { event: 'folio.charge_posted', entityType: 'charge', entityId: posting.id,
              propertyId, data: { folioId: folio.id, type: posting.type, amount: posting.amount, description: posting.description }, timestamp: new Date().toISOString() }, `charge:${posting.id}:posted`);
          }
          return true;
        };
        if (Number(evaluation.penaltyAmount) > 0) penaltyPosted = await postFee('policy', evaluation.penaltyAmount, penaltyDescription);
        if (additionalFeeAmount != null && Number(additionalFeeAmount) > 0) {
          await postFee('additional', Number(additionalFeeAmount).toFixed(2), additionalFeeDescription);
        }
      }
      // Forfeit after canonical policy fees so the liability credit offsets
      // those fees before any remaining deposit is recognized as new income.
      const deposits = await this.settleDeposits(reservationId, propertyId, evaluation.depositAction, actor, tx);
      return { penaltyPosted, penaltyAmount: evaluation.penaltyAmount, deposits,
        policyDescription: evaluation.policyDescription, withinFreeWindow: evaluation.withinFreeWindow };
    };
    return transaction ? perform(transaction) : this.db.transaction(perform);
  }

  async settleDeposits(
    reservationId: string,
    propertyId: string,
    depositAction: DepositAction,
    actor?: AuditActor,
    tx?: any,
  ) {
    const held = await this.listHeldDeposits(reservationId, propertyId, tx);
    const results: Array<{ id: string; status: string; amount: string }> = [];

    for (const entry of held) {
      let updated;
      if (depositAction === 'refund') {
        if (entry.isRefundable) {
          updated = await this.depositService.refundDeposit(entry.id, propertyId, actor, tx);
        } else {
          // Non-refundable deposits cannot take the refund path — forfeit instead.
          updated = await this.depositService.forfeitDeposit(entry.id, propertyId, actor, tx);
        }
      } else {
        updated = await this.depositService.forfeitDeposit(entry.id, propertyId, actor, tx);
      }
      results.push({ id: updated.id, status: updated.status, amount: updated.amount });
    }

    return results;
  }

  private async ensureGuestFolio(reservationId: string, propertyId: string, tx?: any, actor?: AuditActor) {
    const db = tx ?? this.db;
    const [existing] = await db
      .select()
      .from(folios)
      .where(
        and(
          eq(folios.reservationId, reservationId),
          eq(folios.propertyId, propertyId),
          eq(folios.type, 'guest' as any),
        ),
      ).for('update');
    if (existing) return existing;

    // createAutoFolio needs a reservation-like object; load minimal fields via deposit reservation join path
    const [reservation] = await db
      .select()
      .from(reservations)
      .where(and(eq(reservations.id, reservationId), eq(reservations.propertyId, propertyId)));
    const created = await this.folioService.createAutoFolio(reservation, tx);
    await db.insert(auditLogs).values({ propertyId, action: 'create', entityType: 'folio', entityId: created.id,
      description: 'Guest folio created for policy settlement', newValue: { reservationId, folioNumber: created.folioNumber }, ...actorFields(actor) });
    await this.outbox.persist(db, { event: 'folio.created', entityType: 'folio', entityId: created.id, propertyId,
      data: { folioNumber: created.folioNumber, type: created.type }, timestamp: new Date().toISOString() }, `folio:${created.id}:created`);
    return created;
  }
}
