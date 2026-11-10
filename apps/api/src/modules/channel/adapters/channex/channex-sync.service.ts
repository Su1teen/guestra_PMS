import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, eq, isNull, lte } from 'drizzle-orm';
import { bookings, channelRevisionReceipts } from '@telivityhaip/database';
import { DRIZZLE } from '../../../../database/database.module';
import { AriService } from '../../ari.service';
import { ChannelService } from '../../channel.service';
import { InboundReservationService } from '../../inbound-reservation.service';
import { ChannexAdapter } from './channex.adapter';

type Receipt = typeof channelRevisionReceipts.$inferSelect;

@Injectable()
export class ChannexSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChannexSyncService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly nextPoll = new Map<string, number>();

  constructor(
    @Inject(DRIZZLE) private readonly db: any,
    private readonly config: ConfigService,
    private readonly channelService: ChannelService,
    private readonly inbound: InboundReservationService,
    private readonly adapter: ChannexAdapter,
    private readonly ari: AriService,
  ) {}

  onModuleInit() {
    if (this.config.get('NODE_ENV') === 'test') return;
    this.timer = setInterval(() => { void this.run(); }, 15_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async run() {
    if (this.running) return;
    this.running = true;
    try {
      const connections = await this.channelService.findByAdapterType('channex');
      for (const connection of connections) {
        if (this.config.get('CHANNEX_POLL_ENABLED') === 'true' && connection.status === 'active' &&
            connection.syncDirection !== 'push' &&
            (this.nextPoll.get(connection.id) ?? 0) <= Date.now()) {
          await this.poll(connection.id, connection.propertyId);
        }
        const pending = await this.db.select().from(channelRevisionReceipts)
          .where(and(eq(channelRevisionReceipts.propertyId, connection.propertyId),
            eq(channelRevisionReceipts.channelConnectionId, connection.id),
            isNull(channelRevisionReceipts.completedAt), lte(channelRevisionReceipts.retryAt, new Date())))
          .orderBy(asc(channelRevisionReceipts.insertedAt)).limit(20);
        for (const receipt of pending) await this.deliver(receipt);
      }
    } catch {
      this.logger.warn('Channex synchronization recovery unavailable');
    } finally {
      this.running = false;
    }
  }

  private async poll(connectionId: string, propertyId: string) {
    let success = false;
    try {
      const result = await this.inbound.pullAndProcessReservations(connectionId, propertyId);
      success = result.success === true;
    } catch {
      // The unacknowledged feed remains available for the next recovery pass.
    }
    this.nextPoll.set(connectionId, Date.now() + (success ? 30_000 : 60_000));
    if (!success) this.logger.warn(`Channex feed retry pending property=${propertyId} connection=${connectionId}`);
  }

  private async deliver(receipt: Receipt) {
    const { propertyId, channelConnectionId, revisionId } = receipt;
    const scope = and(eq(channelRevisionReceipts.propertyId, propertyId),
      eq(channelRevisionReceipts.channelConnectionId, channelConnectionId),
      eq(channelRevisionReceipts.revisionId, revisionId));
    await this.db.transaction(async (tx: any) => {
      const [pending] = await tx.select().from(channelRevisionReceipts)
        .where(and(scope, isNull(channelRevisionReceipts.completedAt), lte(channelRevisionReceipts.retryAt, new Date())))
        .for('update', { skipLocked: true }) as Receipt[];
      if (!pending) return;
      let acknowledgedAt = pending.acknowledgedAt;
      let step = 'ACK';
      let retryAfterMs = 0;
      try {
        const connection = await this.channelService.findById(channelConnectionId, propertyId);
        if (!connection.isActive || connection.adapterType !== 'channex') throw new Error('Inactive connection');
        if (!acknowledgedAt) {
          const [booking] = await tx.select({
            confirmationNumber: bookings.confirmationNumber, externalConfirmation: bookings.externalConfirmation,
          }).from(bookings).where(and(eq(bookings.propertyId, propertyId), eq(bookings.id, pending.bookingId)));
          if (!booking?.externalConfirmation) throw new Error('Missing committed booking');
          const ack = await this.adapter.confirmReservation({
            channelConnectionId, connectionConfig: connection.config ?? {},
            externalRevisionId: revisionId, externalConfirmation: booking.externalConfirmation,
            pmsConfirmationNumber: booking.confirmationNumber,
          });
          if (!ack.success) {
            retryAfterMs = ack.retryAfterMs ?? 0;
            throw new Error('ACK rejected');
          }
          acknowledgedAt = new Date();
        }

        step = 'ARI';
        if (pending.startDate && pending.endDate) {
          const lastNight = new Date(`${pending.endDate}T00:00:00Z`);
          lastNight.setUTCDate(lastNight.getUTCDate() - 1);
          const results = await this.ari.pushAvailability(
            propertyId, pending.startDate, lastNight.toISOString().slice(0, 10), channelConnectionId,
          );
          retryAfterMs = Math.max(0, ...results.map(({ result }) => result.retryAfterMs ?? 0));
          if (!results.length || results.some(({ result }) => !result.success)) throw new Error('ARI rejected');
        }
        await tx.update(channelRevisionReceipts).set({ acknowledgedAt, completedAt: new Date() }).where(scope);
        this.logger.log(`Channex revision delivered property=${propertyId} revision=${revisionId}`);
      } catch {
        const attempts = pending.attempts + 1;
        const delay = Math.min(900_000, 15_000 * 2 ** Math.min(attempts - 1, 6));
        const retryAt = new Date(Date.now() + Math.max(delay, retryAfterMs) + Math.floor(Math.random() * 5_000));
        await tx.update(channelRevisionReceipts).set({ acknowledgedAt, attempts, retryAt }).where(scope);
        this.logger.warn(`Channex ${step} retry property=${propertyId} revision=${revisionId} attempt=${attempts}`);
      }
    });
  }
}
