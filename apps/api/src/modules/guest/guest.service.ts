import { BadRequestException, Injectable, Inject, NotFoundException } from '@nestjs/common';
import { eq, ilike, or, and, sql, inArray, isNull, ne, desc } from 'drizzle-orm';
import {
  guests,
  guestPropertyLinks,
  integrationLinks,
  reservations,
  reservationGuests,
  auditLogs,
  properties,
  rooms,
  roomTypes,
  ratePlans,
  folios,
  charges,
  bookings,
  serviceRequests,
  serviceBookings,
  services,
  maintenanceTickets,
} from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';
import { actorFields, type AuditActor } from '../../common/audit/audit-actor';
import { CreateGuestDto } from './dto/create-guest.dto';
import { UpdateGuestDto } from './dto/update-guest.dto';
import { SearchGuestsDto } from './dto/search-guests.dto';

/**
 * GuestService
 *
 * Multi-tenancy note: guests are cross-property by design (one person may stay
 * at multiple hotels), but API access MUST verify a reservation link at the
 * requesting property — otherwise staff at hotel A can read/modify guest PII
 * belonging to hotel B's customers. Every read/update/delete requires a primary/roster stay link or an existing
 * guest_property_links membership at the requesting property.
 *
 * The one exception is `create()`: a brand-new walk-in has no reservation yet,
 * so creation is NOT scoped by an existing link. The caller still passes its
 * own `propertyId` for audit purposes. Callers that need "find existing guest
 * by email before creating" should expose a dedicated lookup rather than
 * searching unscoped.
 */
@Injectable()
export class GuestService {
  constructor(@Inject(DRIZZLE) private readonly db: any) {}

  /**
   * Verify a stay or explicit guest-property membership at the given property.
   * Throws NotFoundException if they don't — identical response to "no such
   * guest" to avoid leaking cross-property existence.
   */
  private async assertGuestAtProperty(guestId: string, propertyId: string): Promise<void> {
    // Primary guest on a reservation OR named accompanying occupant.
    const [asPrimary, asOccupant, asMember, asServiceGuest] = await Promise.all([
      this.db
        .select({ id: reservations.id })
        .from(reservations)
        .where(
          and(
            eq(reservations.guestId, guestId),
            eq(reservations.propertyId, propertyId),
          ),
        )
        .limit(1),
      this.db
        .select({ id: reservationGuests.id })
        .from(reservationGuests)
        .where(
          and(
            eq(reservationGuests.guestId, guestId),
            eq(reservationGuests.propertyId, propertyId),
          ),
        )
        .limit(1),
      this.db.select({ id: guestPropertyLinks.id }).from(guestPropertyLinks).where(and(eq(guestPropertyLinks.guestId, guestId), eq(guestPropertyLinks.propertyId, propertyId))).limit(1),
      this.db.select({ id: serviceBookings.id }).from(serviceBookings).where(and(eq(serviceBookings.guestId, guestId), eq(serviceBookings.propertyId, propertyId))).limit(1),
    ]);
    if (!asPrimary.length && !asOccupant.length && !asMember.length && !asServiceGuest.length) {
      throw new NotFoundException(`Guest ${guestId} not found`);
    }
  }

  async createAtProperty(dto: CreateGuestDto, propertyId: string, actor?: AuditActor) {
    return this.db.transaction(async (tx: any) => {
      const guest = await this.create(dto, tx);
      await tx.insert(guestPropertyLinks).values({ guestId: guest.id, propertyId, source: 'pms' });
      await tx.insert(auditLogs).values({ propertyId, action: 'create', entityType: 'guest', entityId: guest.id, description: 'guest_profile_created', ...actorFields(actor) });
      return guest;
    });
  }

  async create(dto: CreateGuestDto, tx?: any) {
    const db = tx ?? this.db;
    const values: Record<string, unknown> = { ...dto };
    if (dto.idExpiry) {
      values['idExpiry'] = new Date(dto.idExpiry);
    }
    if (dto.gdprConsentMarketing) {
      values['gdprConsentDate'] = new Date();
    }
    const [guest] = await db.insert(guests).values(values).returning();
    return guest;
  }

  async findById(id: string, propertyId: string) {
    await this.assertGuestAtProperty(id, propertyId);
    const [guest] = await this.db
      .select()
      .from(guests)
      .where(eq(guests.id, id));
    if (!guest) {
      throw new NotFoundException(`Guest ${id} not found`);
    }
    // Bug 4: after GDPR erasure, treat the guest as not found. Booking history
    // remains but the profile is tombstoned — returning anonymized PII here
    // would leak the fact that the user once existed (and the decision we made).
    if (guest.isDeleted || guest.mergedIntoGuestId) {
      throw new NotFoundException(`Guest ${id} not found`);
    }
    return guest;
  }

  async update(id: string, propertyId: string, dto: UpdateGuestDto) {
    await this.assertGuestAtProperty(id, propertyId);
    // Bug 4: once erased, treat the row as gone.
    const [existing] = await this.db
      .select({ isDeleted: guests.isDeleted })
      .from(guests)
      .where(eq(guests.id, id));
    if (existing?.isDeleted) {
      throw new NotFoundException(`Guest ${id} not found`);
    }
    const values: Record<string, unknown> = { ...dto, updatedAt: new Date() };
    if (dto.idExpiry) {
      values['idExpiry'] = new Date(dto.idExpiry);
    }
    if (dto.isDnr === true && !dto.dnrReason) {
      // Keep existing reason if not provided
    }
    if (dto.isDnr === true) {
      values['dnrDate'] = new Date();
    }
    if (dto.isDnr === false) {
      values['dnrReason'] = null;
      values['dnrDate'] = null;
    }
    if (dto.gdprConsentMarketing !== undefined) {
      values['gdprConsentDate'] = dto.gdprConsentMarketing ? new Date() : null;
    }

    const [guest] = await this.db
      .update(guests)
      .set(values)
      .where(eq(guests.id, id))
      .returning();
    if (!guest) {
      throw new NotFoundException(`Guest ${id} not found`);
    }
    return guest;
  }

  async delete(id: string, propertyId: string, actor?: AuditActor) {
    // Bug 4: GDPR right-to-erasure. Hard DELETE fails on FK constraints from
    // bookings.guest_id / reservations.guest_id (operational/legal retention
    // requires we keep stay history). Instead, anonymize PII in place and
    // flip isDeleted. findById/update below treat isDeleted=true as 404.
    await this.assertGuestAtProperty(id, propertyId);

    const now = new Date();
    const [anonymized] = await this.db
      .update(guests)
      .set({
        email: `anon+${id}@deleted.local`,
        firstName: 'Deleted',
        lastName: 'User',
        phone: null,
        dateOfBirth: null,
        idType: null,
        idNumber: null,
        idCountry: null,
        idExpiry: null,
        nationality: null,
        gender: null,
        profession: null,
        taxId: null,
        registrationData: null,
        addressLine1: null,
        addressLine2: null,
        city: null,
        stateProvince: null,
        postalCode: null,
        countryCode: null,
        companyName: null,
        loyaltyNumber: null,
        notes: null,
        preferences: {},
        dnrReason: null,
        gdprConsentMarketing: false,
        gdprConsentDate: null,
        isDeleted: true,
        deletedAt: now,
        updatedAt: now,
      })
      .where(eq(guests.id, id))
      .returning();

    if (!anonymized) {
      throw new NotFoundException(`Guest ${id} not found`);
    }

    // Write an audit log WITHOUT the previous PII — including it would defeat
    // the erasure. Record just that the erasure happened, who, and why.
    await this.db.insert(auditLogs).values({
      propertyId,
      action: 'delete',
      entityType: 'guest',
      entityId: id,
      description: 'gdpr_erasure',
      ...actorFields(actor),
    });

    return { deleted: true };
  }

  async search(propertyId: string, dto: SearchGuestsDto) {
    // Scope to guests with ≥1 reservation at this property.
    // Subquery: distinct guest_id from reservations where property_id = $1.
    // Bug 4: also exclude GDPR-erased guests from search results.
    // Guests linked as reservation primary OR as named accompanying occupants.
    const conditions: any[] = [
      eq(guests.isDeleted, false),
      isNull(guests.mergedIntoGuestId),
      or(
        inArray(guests.id, this.db.select({ guestId: guestPropertyLinks.guestId }).from(guestPropertyLinks).where(eq(guestPropertyLinks.propertyId, propertyId))),
        inArray(guests.id, this.db.select({ guestId: serviceBookings.guestId }).from(serviceBookings).where(eq(serviceBookings.propertyId, propertyId))),
        inArray(
          guests.id,
          this.db
            .select({ guestId: reservations.guestId })
            .from(reservations)
            .where(eq(reservations.propertyId, propertyId)),
        ),
        inArray(
          guests.id,
          this.db
            .select({ guestId: reservationGuests.guestId })
            .from(reservationGuests)
            .where(eq(reservationGuests.propertyId, propertyId)),
        ),
      ),
    ];

    if (dto.search) {
      const pattern = `%${dto.search}%`;
      conditions.push(
        or(
          ilike(guests.firstName, pattern),
          ilike(guests.lastName, pattern),
          ilike(guests.email, pattern),
          ilike(guests.phone, pattern),
          ilike(guests.taxId, pattern),
          ilike(guests.idNumber, pattern),
          ilike(guests.loyaltyNumber, pattern),
        ),
      );
    }

    if (dto.loyaltyNumber) {
      conditions.push(eq(guests.loyaltyNumber, dto.loyaltyNumber));
    }

    if (dto.vipLevel) {
      conditions.push(eq(guests.vipLevel, dto.vipLevel as any));
    }

    if (dto.isDnr !== undefined) {
      conditions.push(eq(guests.isDnr, dto.isDnr));
    }

    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const offset = (page - 1) * limit;

    const whereClause = and(...conditions);

    const [data, countResult] = await Promise.all([
      this.db
        .select()
        .from(guests)
        .where(whereClause)
        .limit(limit)
        .offset(offset)
        .orderBy(guests.lastName, guests.firstName),
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(guests)
        .where(whereClause),
    ]);

    return {
      data,
      total: Number(countResult[0]?.count ?? 0),
      page,
      limit,
    };
  }

  /** Guest 360 is calculated from the operational ledgers, never stored from a mock/profile total. */
  async get360(id: string, propertyId: string, authorizedPropertyIds: string[] = [propertyId]) {
    await this.assertGuestAtProperty(id, propertyId);
    const scope = [...new Set(authorizedPropertyIds.length ? authorizedPropertyIds : [propertyId])];
    if (!scope.includes(propertyId)) scope.push(propertyId);
    const guest = await this.findById(id, propertyId);

    const occupantReservationIds = this.db
      .select({ reservationId: reservationGuests.reservationId })
      .from(reservationGuests)
      .where(and(
        eq(reservationGuests.guestId, id),
        inArray(reservationGuests.propertyId, scope),
      ));

    const stayRows = await this.db.select({
      reservation: reservations,
      propertyName: properties.name,
      roomNumber: rooms.number,
      roomType: roomTypes.name,
      ratePlan: ratePlans.name,
    }).from(reservations)
      .innerJoin(properties, eq(properties.id, reservations.propertyId))
      .leftJoin(rooms, and(eq(rooms.id, reservations.roomId), eq(rooms.propertyId, reservations.propertyId)))
      .leftJoin(roomTypes, and(eq(roomTypes.id, reservations.roomTypeId), eq(roomTypes.propertyId, reservations.propertyId)))
      .leftJoin(ratePlans, and(eq(ratePlans.id, reservations.ratePlanId), eq(ratePlans.propertyId, reservations.propertyId)))
      .where(and(
        inArray(reservations.propertyId, scope),
        or(
          eq(reservations.guestId, id),
          inArray(reservations.id, occupantReservationIds),
        ),
      )).orderBy(desc(reservations.arrivalDate));

    const reservationIds = stayRows.map((s: any) => s.reservation.id);
    const folioRows = await this.db.select().from(folios).where(and(
      inArray(folios.propertyId, scope),
      reservationIds.length ? or(eq(folios.guestId, id), inArray(folios.reservationId, reservationIds)) : eq(folios.guestId, id),
    ));
    const bookedServices = await this.db.select({ id: serviceBookings.id, propertyId: serviceBookings.propertyId,
      propertyName: properties.name, serviceName: services.name, status: serviceBookings.status,
      scheduledAt: serviceBookings.startAt, reservationId: serviceBookings.reservationId,
    }).from(serviceBookings)
      .innerJoin(services, and(eq(services.id, serviceBookings.serviceId), eq(services.propertyId, serviceBookings.propertyId)))
      .innerJoin(properties, eq(properties.id, serviceBookings.propertyId))
      .where(and(eq(serviceBookings.guestId, id), inArray(serviceBookings.propertyId, scope))).orderBy(desc(serviceBookings.startAt));
    const folioIds = folioRows.map((f: any) => f.id);
    const chargeRows = folioIds.length
      ? await this.db.select().from(charges).where(and(
          inArray(charges.propertyId, scope),
          inArray(charges.folioId, folioIds),
        )).orderBy(desc(charges.serviceDate))
      : [];

    const netCharge = (c: any) => c.isReversal ? -Math.abs(Number(c.amount)) : Number(c.amount);
    const foliosByReservation = new Map<string, any[]>();
    for (const folio of folioRows) {
      if (!folio.reservationId) continue;
      const list = foliosByReservation.get(folio.reservationId) ?? [];
      list.push(folio);
      foliosByReservation.set(folio.reservationId, list);
    }
    const chargesByFolio = new Map<string, any[]>();
    for (const charge of chargeRows) {
      if (!charge.folioId) continue;
      const list = chargesByFolio.get(charge.folioId) ?? [];
      list.push(charge);
      chargesByFolio.set(charge.folioId, list);
    }

    const stays = stayRows.map((row: any) => {
      const stayFolios = foliosByReservation.get(row.reservation.id) ?? [];
      const stayCharges = stayFolios.flatMap((f: any) => chargesByFolio.get(f.id) ?? []);
      return {
        id: row.reservation.id,
        propertyId: row.reservation.propertyId,
        propertyName: row.propertyName,
        arrivalDate: row.reservation.arrivalDate,
        departureDate: row.reservation.departureDate,
        nights: row.reservation.nights,
        roomNumber: row.roomNumber,
        roomType: row.roomType,
        ratePlan: row.ratePlan,
        status: row.reservation.status,
        currencyCode: row.reservation.currencyCode,
        totalRevenue: stayCharges.reduce((sum: number, c: any) => sum + netCharge(c), 0),
      };
    });

    const ancillaryTypes = new Set(['food_beverage', 'minibar', 'phone', 'laundry', 'parking', 'spa', 'incidental', 'fee', 'package']);
    const serviceHistory = chargeRows.filter((c: any) => ancillaryTypes.has(c.type)).map((c: any) => {
      const folio = folioRows.find((f: any) => f.id === c.folioId);
      const stay = stays.find((s: any) => s.id === folio?.reservationId);
      return {
        id: c.id,
        date: c.serviceDate,
        propertyId: c.propertyId,
        propertyName: stay?.propertyName,
        reservationId: folio?.reservationId,
        folioId: c.folioId,
        type: c.type,
        description: c.description,
        amount: netCharge(c),
        currencyCode: c.currencyCode,
        status: c.isReversal ? 'reversed' : 'posted',
      };
    });

    const ltvByCurrency: Record<string, { roomRevenue: number; ancillaryRevenue: number; totalRevenue: number }> = {};
    for (const c of chargeRows) {
      const bucket = ltvByCurrency[c.currencyCode] ?? { roomRevenue: 0, ancillaryRevenue: 0, totalRevenue: 0 };
      const amount = netCharge(c);
      if (c.type === 'room') bucket.roomRevenue += amount;
      else if (ancillaryTypes.has(c.type)) bucket.ancillaryRevenue += amount;
      bucket.totalRevenue += amount;
      ltvByCurrency[c.currencyCode] = bucket;
    }
    const totalStays = stays.filter((s: any) => s.status === 'checked_out').length;
    const activePropertyCurrency = stays.find((s: any) => s.propertyId === propertyId)?.currencyCode
      ?? Object.keys(ltvByCurrency)[0]
      ?? null;
    const activeLtv = activePropertyCurrency ? ltvByCurrency[activePropertyCurrency] : undefined;

    const lineageRows = await this.db.select({ id: guests.id }).from(guests)
      .where(eq(guests.mergedIntoGuestId, id));
    const timelineGuestIds = [id, ...lineageRows.map((g: any) => g.id)];
    const entityIds = [
      ...timelineGuestIds,
      ...reservationIds,
      ...folioIds,
      ...chargeRows.map((c: any) => c.id),
    ];
    // Return the public timeline contract only. Internal bigint sequence values
    // cannot be JSON-serialized and are not needed by the guest workspace.
    const timeline = entityIds.length ? await this.db.select({
      id: auditLogs.id, action: auditLogs.action, entityType: auditLogs.entityType,
      entityId: auditLogs.entityId, description: auditLogs.description,
      occurredAt: auditLogs.occurredAt, userEmail: auditLogs.userEmail,
    }).from(auditLogs).where(and(
      inArray(auditLogs.propertyId, scope),
      inArray(auditLogs.entityId, entityIds),
    )).orderBy(desc(auditLogs.occurredAt)).limit(100) : [];

    const now = new Date().toISOString().slice(0, 10);
    const currentOrUpcoming = stays.find((s: any) =>
      ['checked_in', 'stayover', 'due_out', 'pending', 'confirmed', 'assigned'].includes(s.status)
      && s.departureDate >= now,
    ) ?? null;

    return {
      guest,
      summary: {
        totalStays,
        firstStay: stays.length ? stays[stays.length - 1]?.arrivalDate : null,
        lastStay: stays.length ? stays[0]?.departureDate : null,
        propertiesVisited: [...new Set(stays.map((s: any) => s.propertyName))],
        currentOrUpcoming,
        currencyCode: activePropertyCurrency,
        roomRevenue: activeLtv?.roomRevenue ?? 0,
        ancillaryRevenue: activeLtv?.ancillaryRevenue ?? 0,
        totalRevenue: activeLtv?.totalRevenue ?? 0,
        averageSpendPerStay: totalStays > 0 ? (activeLtv?.totalRevenue ?? 0) / totalStays : 0,
        byCurrency: ltvByCurrency,
      },
      stays,
      services: serviceHistory,
      bookedServices,
      timeline,
    };
  }

  async findDuplicates(id: string, propertyId: string) {
    const guest = await this.findById(id, propertyId);
    const email = guest.email?.trim().toLowerCase();
    const phoneDigits = guest.phone?.replace(/\D/g, '');
    if (!email && !phoneDigits) return [];
    const candidates = await this.db.select().from(guests).where(and(
      ne(guests.id, id),
      eq(guests.isDeleted, false),
      isNull(guests.mergedIntoGuestId),
      or(
        ...(email ? [sql`lower(trim(${guests.email})) = ${email}`] : []),
        ...(phoneDigits ? [sql`regexp_replace(coalesce(${guests.phone}, ''), '\\D', '', 'g') = ${phoneDigits}`] : []),
      ),
    ));
    const accessible: any[] = [];
    for (const candidate of candidates) {
      try {
        await this.assertGuestAtProperty(candidate.id, propertyId);
        accessible.push(candidate);
      } catch { /* do not disclose cross-property identities */ }
    }
    return accessible;
  }

  async merge(sourceId: string, targetId: string, propertyId: string, confirmed: boolean, actor?: AuditActor) {
    if (!confirmed) throw new BadRequestException('Guest merge requires explicit confirmation');
    if (sourceId === targetId) throw new BadRequestException('Source and target guests must differ');
    const [source, target] = await Promise.all([
      this.findById(sourceId, propertyId),
      this.findById(targetId, propertyId),
    ]);

    // A guest identity is global. A user who only selected one property must not
    // silently rewrite another property's guest history during a merge.
    const linkedProperties = await this.db.select({ propertyId: reservations.propertyId })
      .from(reservations)
      .leftJoin(reservationGuests, and(
        eq(reservationGuests.reservationId, reservations.id),
        eq(reservationGuests.propertyId, reservations.propertyId),
      ))
      .where(or(
        inArray(reservations.guestId, [sourceId, targetId]),
        inArray(reservationGuests.guestId, [sourceId, targetId]),
      ));
    const serviceLinks = await this.db.select({ propertyId: guestPropertyLinks.propertyId }).from(guestPropertyLinks).where(inArray(guestPropertyLinks.guestId, [sourceId, targetId]));
    const serviceStays = await this.db.select({ propertyId: serviceBookings.propertyId }).from(serviceBookings).where(inArray(serviceBookings.guestId, [sourceId, targetId]));
    const directFolios = await this.db.select({ propertyId: folios.propertyId }).from(folios).where(inArray(folios.guestId, [sourceId, targetId]));
    linkedProperties.push(...serviceLinks, ...serviceStays, ...directFolios);
    if (linkedProperties.some((row: { propertyId: string }) => row.propertyId !== propertyId)) {
      throw new BadRequestException(
        'These profiles contain history at another property; merge requires access to every linked property',
      );
    }

    const merged = await this.db.transaction(async (tx: any) => {
      const now = new Date();
      const combinedPreferences = { ...(source.preferences ?? {}), ...(target.preferences ?? {}) };
      const combinedNotes = [target.notes, source.notes].filter(Boolean).join('\n--- Merged profile ---\n') || null;
      const [updatedTarget] = await tx.update(guests).set({
        email: target.email ?? source.email,
        phone: target.phone ?? source.phone,
        idType: target.idType ?? source.idType,
        idNumber: target.idNumber ?? source.idNumber,
        idCountry: target.idCountry ?? source.idCountry,
        nationality: target.nationality ?? source.nationality,
        dateOfBirth: target.dateOfBirth ?? source.dateOfBirth,
        loyaltyNumber: target.loyaltyNumber ?? source.loyaltyNumber,
        companyName: target.companyName ?? source.companyName,
        preferences: combinedPreferences,
        notes: combinedNotes,
        updatedAt: now,
      }).where(eq(guests.id, targetId)).returning();

      await tx.update(bookings).set({ guestId: targetId, updatedAt: now }).where(eq(bookings.guestId, sourceId));
      await tx.update(reservations).set({ guestId: targetId, updatedAt: now }).where(eq(reservations.guestId, sourceId));
      const targetOccupancies = await tx.select({ reservationId: reservationGuests.reservationId })
        .from(reservationGuests).where(eq(reservationGuests.guestId, targetId));
      const duplicateReservationIds = targetOccupancies.map((row: { reservationId: string }) => row.reservationId);
      if (duplicateReservationIds.length > 0) {
        await tx.delete(reservationGuests).where(and(
          eq(reservationGuests.guestId, sourceId),
          inArray(reservationGuests.reservationId, duplicateReservationIds),
        ));
      }
      await tx.update(reservationGuests).set({ guestId: targetId, updatedAt: now }).where(eq(reservationGuests.guestId, sourceId));
      await tx.update(folios).set({ guestId: targetId, updatedAt: now }).where(eq(folios.guestId, sourceId));
      const targetLinks = await tx.select({ propertyId: guestPropertyLinks.propertyId }).from(guestPropertyLinks).where(eq(guestPropertyLinks.guestId, targetId));
      const duplicateProperties = targetLinks.map((row: any) => row.propertyId);
      if (duplicateProperties.length) await tx.delete(guestPropertyLinks).where(and(eq(guestPropertyLinks.guestId, sourceId), inArray(guestPropertyLinks.propertyId, duplicateProperties)));
      await tx.update(guestPropertyLinks).set({ guestId: targetId, updatedAt: now }).where(eq(guestPropertyLinks.guestId, sourceId));
      await tx.update(serviceBookings).set({ guestId: targetId, updatedAt: now }).where(eq(serviceBookings.guestId, sourceId));
      await tx.update(integrationLinks).set({ localEntityId: targetId, updatedAt: now }).where(and(eq(integrationLinks.localEntityType, 'guest'), eq(integrationLinks.localEntityId, sourceId)));
      await tx.update(serviceRequests).set({ guestId: targetId, updatedAt: now }).where(eq(serviceRequests.guestId, sourceId));
      await tx.update(maintenanceTickets).set({ guestId: targetId, updatedAt: now }).where(eq(maintenanceTickets.guestId, sourceId));
      await tx.update(guests).set({ mergedIntoGuestId: targetId, mergedAt: now, updatedAt: now })
        .where(eq(guests.id, sourceId));
      await tx.insert(auditLogs).values({
        propertyId,
        action: 'merge',
        entityType: 'guest',
        entityId: targetId,
        previousValue: { sourceGuestId: sourceId, targetGuestId: targetId },
        newValue: { guestId: targetId },
        description: 'guest_profiles_merged',
        ...actorFields(actor),
      });
      return updatedTarget;
    });
    return { guest: merged, sourceGuestId: sourceId, targetGuestId: targetId };
  }
}
