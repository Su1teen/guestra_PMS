import { Injectable, Inject, Logger, Optional, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { eq, and, desc, sql } from 'drizzle-orm';
import { auditLogs, bookings, reservations, guests, channelConnections, channelRevisionReceipts, roomTypes, ratePlans } from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';
import { ChannelService } from './channel.service';
import { ChannelAdapterFactory } from './channel-adapter.factory';
import { AriService } from './ari.service';
import { WebhookService } from '../webhook/webhook.service';
import { DomainEventOutboxService } from '../webhook/domain-event-outbox.service';
import { AvailabilityService } from '../reservation/availability.service';
import { RoomStatusService } from '../room/room-status.service';
import { generateConfirmationToken } from '../connect/connect-booking.service';
import type { ChannelReservation } from './channel-adapter.interface';

@Injectable()
export class InboundReservationService {
  private readonly logger = new Logger(InboundReservationService.name);
  constructor(
    @Inject(DRIZZLE) private readonly db: any,
    private readonly channelService: ChannelService,
    private readonly adapterFactory: ChannelAdapterFactory,
    private readonly ariService: AriService,
    private readonly webhookService: WebhookService,
    private readonly availabilityService: AvailabilityService,
    private readonly roomStatusService: RoomStatusService,
    @Optional() private readonly outbox?: DomainEventOutboxService,
  ) {}

  /**
   * Process an inbound reservation from a channel (KB 6.1).
   * Handles new, modified, and cancelled reservations.
   * Deduplication key: externalConfirmation + channelCode.
   */
  async processInboundReservation(
    channelConnectionId: string,
    reservation: ChannelReservation,
    trustedChannex = false,
  ) {
    // Get channel connection for property context and mappings
    const conn = await this.findConnectionForInbound(channelConnectionId);
    if (conn.adapterType === 'channex') {
      if (!trustedChannex) throw new BadRequestException('Read Channex revisions from the authenticated feed');
      return this.processRevision(conn, reservation);
    }
    if (reservation.channelCode.startsWith('SIMULATED:')) {
      throw new BadRequestException('Use the dedicated simulation endpoint');
    }
    const propertyId = conn.propertyId;

    // Check deduplication — scoped to the connection's property to prevent
    // cross-tenant collisions on externalConfirmation + channelCode.
    const existing = await this.findByExternalConfirmation(
      reservation.externalConfirmation,
      reservation.channelCode,
      propertyId,
    );

    if (reservation.status === 'cancelled') {
      return this.handleCancellation(conn, reservation, existing);
    }

    if (reservation.status === 'modified' && existing) {
      return this.handleModification(conn, reservation, existing);
    }

    if (existing) {
      return this.returnExistingInbound(existing, propertyId);
    }

    return this.handleNewReservation(conn, reservation);
  }

  async processSimulatedRevision(channelConnectionId: string, propertyId: string, reservation: ChannelReservation) {
    const conn = await this.channelService.findById(channelConnectionId, propertyId);
    if (conn.adapterType !== 'mock' || !conn.channelCode.startsWith('SIMULATED:') ||
        conn.channelCode !== reservation.channelCode) {
      throw new BadRequestException('This connection is outside the simulation');
    }
    return this.processRevision(conn, reservation);
  }

  private async processRevision(conn: typeof channelConnections.$inferSelect, reservation: ChannelReservation) {
    const { externalRevisionId: revisionId, channelBookingDate, externalConfirmation } = reservation;
    const simulated = conn.adapterType === 'mock';
    const vendorProperty = simulated ? undefined : conn.config?.['propertyId'] ?? conn.config?.['hotelId'];
    const channelCode = simulated ? conn.channelCode : 'channex';
    if (!conn.isActive || reservation.channelCode !== channelCode || !revisionId ||
        !externalConfirmation || !Number.isFinite(channelBookingDate.getTime()) ||
        (vendorProperty && vendorProperty !== reservation.channelHotelId)) {
      throw new BadRequestException('Invalid Channex revision for this connection');
    }
    const { propertyId } = conn;
    const scope = and(
      eq(channelRevisionReceipts.propertyId, propertyId),
      eq(channelRevisionReceipts.channelConnectionId, conn.id),
    );
    const result = await this.db.transaction(async (tx: any) => {
      // Serialize webhook and feed deliveries for the same connection, across replicas.
      const [active] = await tx.select({ id: channelConnections.id }).from(channelConnections)
        .where(and(eq(channelConnections.id, conn.id), eq(channelConnections.propertyId, propertyId),
          eq(channelConnections.isActive, true))).for('update');
      if (!active) throw new ConflictException('Channex connection is inactive');

      const existing = await this.findByExternalConfirmation(externalConfirmation, channelCode, propertyId, tx);
      const [duplicate] = await tx.select().from(channelRevisionReceipts)
        .where(and(scope, eq(channelRevisionReceipts.revisionId, revisionId)));
      if (duplicate) {
        if (existing?.id !== duplicate.bookingId) throw new ConflictException('Channex revision identity mismatch');
        return { bookingId: existing.id, reservationId: duplicate.reservationId, confirmationNumber: existing.confirmationNumber };
      }

      const [current] = existing ? await tx.select().from(reservations)
        .where(and(eq(reservations.bookingId, existing.id), eq(reservations.propertyId, propertyId))) : [];
      if (existing && !current) throw new ConflictException('Channex booking is missing its reservation');
      const [latest] = existing ? await tx.select().from(channelRevisionReceipts)
        .where(and(scope, eq(channelRevisionReceipts.bookingId, existing.id)))
        .orderBy(desc(channelRevisionReceipts.insertedAt)).limit(1) : [];

      const stale = !!current && (
        (latest && latest.insertedAt > channelBookingDate) ||
        current.status === 'cancelled' || reservation.status === 'new'
      );
      let applied;
      if (stale) {
        applied = { bookingId: existing.id, reservationId: current.id, confirmationNumber: existing.confirmationNumber };
      } else if (reservation.status === 'cancelled') {
        applied = await this.handleCancellation(conn, reservation, existing, tx);
      } else if (existing) {
        applied = await this.handleModification(conn, reservation, existing, tx);
      } else {
        applied = await this.handleNewReservation(conn, reservation, tx);
      }

      // Channex needs an absolute ARI update for both the new and the released nights.
      const startDate = stale ? null : [current?.arrivalDate, reservation.arrivalDate].filter(Boolean).sort()[0];
      const endDate = stale ? null : [current?.departureDate, reservation.departureDate].filter(Boolean).sort().at(-1);
      await tx.insert(channelRevisionReceipts).values({
        propertyId, channelConnectionId: conn.id, revisionId,
        bookingId: applied.bookingId, reservationId: applied.reservationId,
        insertedAt: channelBookingDate, startDate, endDate,
        completedAt: simulated ? new Date() : null,
      });
      if (!stale && simulated) {
        await tx.insert(auditLogs).values({
          propertyId, action: 'create', entityType: 'reservation', entityId: applied.reservationId,
          description: 'SIMULATED channel revision',
          newValue: { channelCode, revisionId, status: reservation.status },
        });
      } else if (!stale) {
        await this.outbox?.persist(tx, {
          event: 'channel.reservation_received', entityType: 'reservation', entityId: applied.reservationId,
          propertyId, timestamp: new Date().toISOString(),
          data: { channelCode: 'channex', externalConfirmation, status: reservation.status },
        }, `channex:${conn.id}:${revisionId}`);
      }
      return applied;
    });
    this.logger.log(`${channelCode} revision recorded property=${propertyId} revision=${revisionId} status=${reservation.status}`);
    return result;
  }

  /**
   * Pull reservations from a channel and process them.
   */
  async pullAndProcessReservations(
    channelConnectionId: string,
    propertyId: string,
    since?: Date,
    externalRevisionId?: string,
  ) {
    const conn = await this.channelService.findById(channelConnectionId, propertyId);
    const adapter = this.adapterFactory.getAdapter(conn.adapterType);

    const result = await adapter.pullReservations({
      propertyId,
      channelConnectionId,
      connectionConfig: (conn.config ?? {}) as Record<string, unknown>,
      since,
      ...(externalRevisionId ? { externalRevisionId } : {}),
    });

    const processed: Array<{ externalConfirmation: string; status: string; pmsConfirmation?: string; error?: string }> = [];
    const blocked = new Set<string>();

    for (const reservation of result.reservations) {
      if (blocked.has(reservation.externalConfirmation)) continue;
      try {
        const res = await this.processInboundReservation(channelConnectionId, reservation, conn.adapterType === 'channex');
        processed.push({
          externalConfirmation: reservation.externalConfirmation,
          status: 'processed',
          pmsConfirmation: res.confirmationNumber,
        });
      } catch (error: any) {
        if (conn.adapterType === 'channex') {
          blocked.add(reservation.externalConfirmation);
          this.logger.warn(`Channex revision requires retry property=${propertyId} revision=${reservation.externalRevisionId} error=${error?.constructor?.name ?? 'Error'}`);
        }
        processed.push({
          externalConfirmation: reservation.externalConfirmation,
          status: 'failed',
          error: error.message,
        });
      }
    }

    return {
      total: result.reservations.length, processed,
      ...(conn.adapterType === 'channex' ? { errors: result.errors, success: result.success && blocked.size === 0 } : {}),
    };
  }

  // --- Private Handlers ---

  private async handleNewReservation(conn: any, reservation: ChannelReservation, revisionTx?: any) {
    const propertyId = conn.propertyId;

    // Resolve channel codes to PMS IDs (outside tx — pure lookups)
    const roomTypeId = this.resolveRoomTypeId(conn, reservation.channelRoomCode);
    const ratePlanId = this.resolveRatePlanId(conn, reservation.channelRateCode, reservation.channelParentRateCode);

    // FK ownership (security audit follow-on): the channel connection's
    // roomTypeMapping/ratePlanMapping JSON is operator-supplied. A misconfigured
    // (or maliciously edited) mapping could point at a foreign-tenant id. Verify
    // BOTH resolved ids belong to THIS connection's propertyId before writing.
    await this.assertSamePropertyFk(roomTypes, roomTypeId, propertyId, 'room type', revisionTx);
    await this.assertSamePropertyFk(ratePlans, ratePlanId, propertyId, 'rate plan', revisionTx);

    // Calculate nights
    const arrival = new Date(reservation.arrivalDate);
    const departure = new Date(reservation.departureDate);
    const nights = Math.ceil((departure.getTime() - arrival.getTime()) / (1000 * 60 * 60 * 24));

    // Generate confirmation number
    const confirmationNumber = this.generateConfirmationNumber();

    // Atomically create guest + booking + reservation so we never end up with a half-written record.
    let created: { guest: any; booking: any; pmsReservation: any };
    try {
      const create = async (tx: any) => {
      await tx.execute(sql`select id from ${roomTypes} where ${roomTypes.id} = ${roomTypeId} and ${roomTypes.propertyId} = ${propertyId} for update`);
      const availability = await this.availabilityService.searchAvailability(
        propertyId,
        reservation.arrivalDate,
        reservation.departureDate,
        roomTypeId,
        tx,
      );
      const roomNights = availability.filter((a: any) => a.roomTypeId === roomTypeId);
      if (roomNights.length === 0 || !roomNights.every((a: any) => a.available > 0)) {
        throw new BadRequestException(
          `No availability for room type ${roomTypeId} on ${reservation.arrivalDate} → ${reservation.departureDate}`,
        );
      }

      const guest = await this.findOrCreateGuestTx(tx, reservation, propertyId);

      const [booking] = await tx
        .insert(bookings)
        .values({
          propertyId,
          guestId: guest.id,
          confirmationNumber,
          externalConfirmation: reservation.externalConfirmation,
          source: 'ota',
          channelCode: reservation.channelCode,
        })
        .returning();

      const [pmsReservation] = await tx
        .insert(reservations)
        .values({
          propertyId,
          bookingId: booking.id,
          guestId: guest.id,
          arrivalDate: reservation.arrivalDate,
          departureDate: reservation.departureDate,
          nights,
          roomTypeId,
          ratePlanId,
          totalAmount: reservation.totalAmount.toString(),
          currencyCode: reservation.currencyCode,
          adults: reservation.adults,
          children: reservation.children ?? 0,
          specialRequests: reservation.specialRequests,
          status: 'confirmed',
        })
        .returning();

      return { guest, booking, pmsReservation };
      };
      created = revisionTx ? await create(revisionTx) : await this.db.transaction(create);
    } catch (err: any) {
      if (!revisionTx && err?.code === '23505') {
        const raced = await this.findByExternalConfirmation(
          reservation.externalConfirmation,
          reservation.channelCode,
          propertyId,
        );
        if (raced) {
          return this.returnExistingInbound(raced, propertyId);
        }
      }
      throw err;
    }

    const { guest, booking, pmsReservation } = created;
    if (revisionTx) {
      return { reservationId: pmsReservation.id, bookingId: booking.id, confirmationNumber, guestId: guest.id };
    }

    // Confirm back to channel (Channex ACKs revision id, not booking id)
    try {
      const adapter = this.adapterFactory.getAdapter(conn.adapterType);
      await adapter.confirmReservation({
        channelConnectionId: conn.id,
        connectionConfig: (conn.config ?? {}) as Record<string, unknown>,
        externalConfirmation: reservation.externalConfirmation,
        externalRevisionId: reservation.externalRevisionId,
        pmsConfirmationNumber: confirmationNumber,
      });
    } catch {
      // Don't fail the reservation if confirmation callback fails
    }

    // Push updated availability for the reservation date range
    try {
      await this.ariService.pushAvailability(
        propertyId,
        reservation.arrivalDate,
        reservation.departureDate,
      );
    } catch {
      // Fire-and-forget
    }

    // Emit webhook
    await this.webhookService.emit(
      'channel.reservation_received',
      'reservation',
      pmsReservation.id,
      {
        channelCode: reservation.channelCode,
        externalConfirmation: reservation.externalConfirmation,
        confirmationNumber,
        status: 'new',
      },
      propertyId,
    );

    return {
      reservationId: pmsReservation.id,
      bookingId: booking.id,
      confirmationNumber,
      guestId: guest.id,
    };
  }

  private async handleModification(conn: any, reservation: ChannelReservation, existing: any, revisionTx?: any) {
    const propertyId = conn.propertyId;

    // Find the existing reservation linked to this booking — scoped to property.
    const [existingReservation] = await (revisionTx ?? this.db)
      .select()
      .from(reservations)
      .where(
        and(
          eq(reservations.bookingId, existing.id),
          eq(reservations.propertyId, propertyId),
        ),
      );

    if (!existingReservation) {
      throw new NotFoundException('Existing reservation not found for modification');
    }

    // Resolve codes
    const roomTypeId = this.resolveRoomTypeId(conn, reservation.channelRoomCode);
    const ratePlanId = this.resolveRatePlanId(conn, reservation.channelRateCode, reservation.channelParentRateCode);

    // FK ownership (security audit follow-on): same as handleNewReservation —
    // verify the operator-supplied channel mapping points at THIS connection's
    // propertyId before mutating the reservation.
    await this.assertSamePropertyFk(roomTypes, roomTypeId, propertyId, 'room type', revisionTx);
    await this.assertSamePropertyFk(ratePlans, ratePlanId, propertyId, 'rate plan', revisionTx);

    const arrival = new Date(reservation.arrivalDate);
    const departure = new Date(reservation.departureDate);
    const nights = Math.ceil((departure.getTime() - arrival.getTime()) / (1000 * 60 * 60 * 24));

    const modify = async (tx: any) => {
      const [current] = await tx.select().from(reservations).where(and(eq(reservations.id, existingReservation.id), eq(reservations.propertyId, propertyId))).for('update');
      if (!current || String(current.updatedAt) !== String(existingReservation.updatedAt)) throw new ConflictException('Бронь изменилась. Повторите обработку изменения канала.');
      if (['cancelled','checked_out','no_show'].includes(current.status)) throw new ConflictException('Нельзя изменять завершённую бронь через канал.');
      if (current.roomId && current.roomTypeId !== roomTypeId) throw new ConflictException('Сначала освободите назначенный номер перед изменением категории.');
      await tx.execute(sql`select id from ${roomTypes} where ${roomTypes.id} = ${roomTypeId} and ${roomTypes.propertyId} = ${propertyId} for update`);
      if (current.roomId) {
        await this.roomStatusService.lockRoom(current.roomId, propertyId, tx);
        await this.roomStatusService.assertInventoryAvailable(current.roomId, propertyId, reservation.departureDate, tx);
      }
      const availability = await this.availabilityService.searchAvailability(
        propertyId,
        reservation.arrivalDate,
        reservation.departureDate,
        roomTypeId,
        tx,
      );

      const currentCountsItself =
        existingReservation.roomTypeId === roomTypeId &&
        (existingReservation.arrivalDate as string) < reservation.departureDate &&
        (existingReservation.departureDate as string) > reservation.arrivalDate;

      const roomNights = availability.filter((a: any) => a.roomTypeId === roomTypeId);
      const nightsOk =
        roomNights.length > 0 &&
        roomNights.every((a: any) => {
          const existingOccupiesThisNight =
            currentCountsItself &&
            (existingReservation.arrivalDate as string) <= a.date &&
            (existingReservation.departureDate as string) > a.date;
          const effectiveAvailable = a.available + (existingOccupiesThisNight ? 1 : 0);
          return effectiveAvailable > 0;
        });

      if (!nightsOk) {
        throw new BadRequestException(
          `No availability for room type ${roomTypeId} on ${reservation.arrivalDate} → ${reservation.departureDate}`,
        );
      }

      return await tx
        .update(reservations)
        .set({
          arrivalDate: reservation.arrivalDate,
          departureDate: reservation.departureDate,
          nights,
          roomTypeId,
          ratePlanId,
          totalAmount: reservation.totalAmount.toString(),
          currencyCode: reservation.currencyCode,
          adults: reservation.adults,
          children: reservation.children ?? 0,
          specialRequests: reservation.specialRequests,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(reservations.id, existingReservation.id),
            eq(reservations.propertyId, propertyId),
          ),
        )
        .returning();
    };
    if (revisionTx) {
      await modify(revisionTx);
      return { reservationId: existingReservation.id, bookingId: existing.id, confirmationNumber: existing.confirmationNumber, guestId: existingReservation.guestId };
    }
    await this.db.transaction(modify);

    // ACK revision before/with availability push (Channex requires ACK after persist)
    try {
      const adapter = this.adapterFactory.getAdapter(conn.adapterType);
      await adapter.confirmReservation({
        channelConnectionId: conn.id,
        connectionConfig: (conn.config ?? {}) as Record<string, unknown>,
        externalConfirmation: reservation.externalConfirmation,
        externalRevisionId: reservation.externalRevisionId,
        pmsConfirmationNumber: existing.confirmationNumber,
      });
    } catch {
      // Don't fail modification if ACK fails — feed will retry
    }

    // Push updated availability
    try {
      await this.ariService.pushAvailability(
        propertyId,
        reservation.arrivalDate,
        reservation.departureDate,
      );
    } catch {
      // Fire-and-forget
    }

    await this.webhookService.emit(
      'channel.reservation_received',
      'reservation',
      existingReservation.id,
      {
        channelCode: reservation.channelCode,
        externalConfirmation: reservation.externalConfirmation,
        confirmationNumber: existing.confirmationNumber,
        status: 'modified',
      },
      propertyId,
    );

    return {
      reservationId: existingReservation.id,
      bookingId: existing.id,
      confirmationNumber: existing.confirmationNumber,
      guestId: existingReservation.guestId,
    };
  }

  private async handleCancellation(conn: any, reservation: ChannelReservation, existing: any, revisionTx?: any) {
    if (!existing) {
      throw new NotFoundException(
        `Cannot cancel: reservation with external confirmation ${reservation.externalConfirmation} not found`,
      );
    }

    const propertyId = conn.propertyId;

    // Find the reservation — scoped to property.
    const [existingReservation] = await (revisionTx ?? this.db)
      .select()
      .from(reservations)
      .where(
        and(
          eq(reservations.bookingId, existing.id),
          eq(reservations.propertyId, propertyId),
        ),
      );

    if (!existingReservation) {
      throw new NotFoundException('Existing reservation not found for cancellation');
    }

    // Cancel it
    await (revisionTx ?? this.db)
      .update(reservations)
      .set({
        status: 'cancelled',
        cancelledAt: new Date(),
        cancellationReason: `Cancelled via channel: ${reservation.channelCode}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(reservations.id, existingReservation.id),
          eq(reservations.propertyId, propertyId),
        ),
      );
    if (revisionTx) {
      return { reservationId: existingReservation.id, bookingId: existing.id, confirmationNumber: existing.confirmationNumber, cancelled: true };
    }

    const arrivalDate = reservation.arrivalDate || existingReservation.arrivalDate;
    const departureDate = reservation.departureDate || existingReservation.departureDate;

    // ACK cancellation revision so it leaves the Channex feed
    try {
      const adapter = this.adapterFactory.getAdapter(conn.adapterType);
      await adapter.confirmReservation({
        channelConnectionId: conn.id,
        connectionConfig: (conn.config ?? {}) as Record<string, unknown>,
        externalConfirmation: reservation.externalConfirmation,
        externalRevisionId: reservation.externalRevisionId,
        pmsConfirmationNumber: existing.confirmationNumber,
      });
    } catch {
      // Don't fail cancellation if ACK fails
    }

    // Push updated availability
    try {
      await this.ariService.pushAvailability(
        propertyId,
        arrivalDate,
        departureDate,
      );
    } catch {
      // Fire-and-forget
    }

    await this.webhookService.emit(
      'channel.reservation_received',
      'reservation',
      existingReservation.id,
      {
        channelCode: reservation.channelCode,
        externalConfirmation: reservation.externalConfirmation,
        confirmationNumber: existing.confirmationNumber,
        status: 'cancelled',
      },
      propertyId,
    );

    return {
      reservationId: existingReservation.id,
      bookingId: existing.id,
      confirmationNumber: existing.confirmationNumber,
      cancelled: true,
    };
  }

  // --- Private Helpers ---

  private async returnExistingInbound(existing: any, propertyId: string) {
    const [existingReservation] = await this.db
      .select()
      .from(reservations)
      .where(
        and(
          eq(reservations.bookingId, existing.id),
          eq(reservations.propertyId, propertyId),
        ),
      );

    if (existingReservation?.status === 'cancelled') {
      throw new ConflictException(
        `Cannot accept duplicate new push for cancelled reservation ${existing.confirmationNumber}`,
      );
    }

    return {
      reservationId: existingReservation?.id,
      bookingId: existing.id,
      confirmationNumber: existing.confirmationNumber,
      guestId: existingReservation?.guestId,
    };
  }

  private async findConnectionForInbound(channelConnectionId: string) {
    // Look up connection without propertyId (inbound doesn't always know it)
    const [conn] = await this.db
      .select()
      .from(channelConnections)
      .where(eq(channelConnections.id, channelConnectionId));

    if (!conn) {
      throw new NotFoundException(`Channel connection ${channelConnectionId} not found`);
    }
    return conn;
  }

  private async findByExternalConfirmation(
    externalConfirmation: string,
    channelCode: string,
    propertyId: string,
    db = this.db,
  ) {
    const [existing] = await db
      .select()
      .from(bookings)
      .where(
        and(
          eq(bookings.propertyId, propertyId),
          eq(bookings.externalConfirmation, externalConfirmation),
          eq(bookings.channelCode, channelCode),
        ),
      );
    return existing ?? null;
  }

  private async findOrCreateGuestTx(tx: any, reservation: ChannelReservation, propertyId: string) {
    // Reuse a guest by email ONLY when that guest is already linked to THIS
    // property via an existing reservation. A bare cross-property email match
    // would let an inbound OTA push attach to (and corrupt) another tenant's
    // guest profile. Otherwise create a fresh row (CLAUDE.md guest rule).
    if (reservation.guestEmail) {
      const matches = await tx
        .select()
        .from(guests)
        .where(eq(guests.email, reservation.guestEmail));
      for (const candidate of matches) {
        const links = await tx
          .select({ id: reservations.id })
          .from(reservations)
          .where(
            and(
              eq(reservations.guestId, candidate.id),
              eq(reservations.propertyId, propertyId),
            ),
          );
        if (links.length > 0) return candidate;
      }
    }
    const [guest] = await tx
      .insert(guests)
      .values({
        firstName: reservation.guestFirstName,
        lastName: reservation.guestLastName,
        email: reservation.guestEmail ?? null,
        phone: reservation.guestPhone ?? null,
      })
      .returning();
    return guest;
  }

  private resolveRoomTypeId(conn: any, channelRoomCode: string): string {
    const roomTypeMapping = (conn.roomTypeMapping ?? []) as Array<{
      roomTypeId: string;
      channelRoomCode: string;
    }>;

    const mapping = roomTypeMapping.find((m) => m.channelRoomCode === channelRoomCode);
    if (!mapping) {
      throw new NotFoundException(
        `No room type mapping found for channel room code '${channelRoomCode}' on connection ${conn.id}`,
      );
    }
    return mapping.roomTypeId;
  }

  private resolveRatePlanId(conn: any, channelRateCode: string, parentRateCode?: string): string {
    const ratePlanMapping = (conn.ratePlanMapping ?? []) as Array<{
      ratePlanId: string;
      channelRateCode: string;
    }>;

    const mapping = ratePlanMapping.find((m) => m.channelRateCode === channelRateCode)
      ?? ratePlanMapping.find((m) => m.channelRateCode === parentRateCode);
    if (!mapping) {
      throw new NotFoundException(
        `No rate plan mapping found for channel rate code '${channelRateCode}' on connection ${conn.id}`,
      );
    }
    return mapping.ratePlanId;
  }

  /**
   * Verify a caller- or mapping-supplied FK row belongs to the SAME property as
   * the channel connection. Mirrors the same check in ReservationService — the
   * channel mapping JSON is operator-supplied and must not be allowed to point
   * at another tenant's room type / rate plan.
   */
  private async assertSamePropertyFk(
    table: { id: any; propertyId: any },
    id: string,
    propertyId: string,
    label: string,
    db = this.db,
  ): Promise<void> {
    const [row] = await db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.id, id), eq(table.propertyId, propertyId)));
    if (!row) {
      throw new BadRequestException(`${label} ${id} not found in this property (channel mapping points at foreign tenant)`);
    }
  }

  private generateConfirmationNumber(): string {
    // The confirmation number is a bearer credential for the booking, so it must
    // be unguessable. The previous `Date.now()`-based value with 4 Math.random
    // chars was enumerable; reuse the shared 128-bit CSPRNG token (Crockford b32).
    return `CH-${generateConfirmationToken()}`;
  }
}
