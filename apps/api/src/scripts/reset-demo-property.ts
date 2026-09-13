import { pathToFileURL } from 'node:url';
import { count, eq, inArray } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as coreSchema from '@telivityhaip/database';
import { postgresOptionsFromEnv } from '@telivityhaip/database';
import {
  demoResetConfirmation,
  readDemoResetConfig,
} from './reset-demo-property.config.js';

type CoreDatabase = PostgresJsDatabase<typeof coreSchema>;
type ResetSummary = {
  propertyId: string;
  propertyName: string;
  deleted: Record<string, number>;
  roomsReset: number;
  guestsDeleted: number;
  guestsRetainedBecauseShared: number;
};

function isGuestId(value: string | null): value is string {
  return value !== null;
}

async function propertyPreview(db: CoreDatabase, propertyId: string) {
  const [property] = await db
    .select({ id: coreSchema.properties.id, name: coreSchema.properties.name })
    .from(coreSchema.properties)
    .where(eq(coreSchema.properties.id, propertyId))
    .limit(1);

  if (!property) {
    throw new Error(`Property ${propertyId} was not found`);
  }

  const [reservationCount, bookingCount, roomCount, propertyCount] = await Promise.all([
    db.select({ value: count() }).from(coreSchema.reservations)
      .where(eq(coreSchema.reservations.propertyId, propertyId)),
    db.select({ value: count() }).from(coreSchema.bookings)
      .where(eq(coreSchema.bookings.propertyId, propertyId)),
    db.select({ value: count() }).from(coreSchema.rooms)
      .where(eq(coreSchema.rooms.propertyId, propertyId)),
    db.select({ value: count() }).from(coreSchema.properties),
  ]);

  const roomStatuses = await db
    .select({ status: coreSchema.rooms.status, value: count() })
    .from(coreSchema.rooms)
    .where(eq(coreSchema.rooms.propertyId, propertyId))
    .groupBy(coreSchema.rooms.status);

  return {
    property,
    propertiesInDatabase: propertyCount[0]?.value ?? 0,
    reservations: reservationCount[0]?.value ?? 0,
    bookings: bookingCount[0]?.value ?? 0,
    rooms: roomCount[0]?.value ?? 0,
    roomStatuses,
  };
}

async function resetDemoProperty(
  db: CoreDatabase,
  propertyId: string,
): Promise<ResetSummary> {
  const requestSchema = process.env['HAIP_BOOKING_REQUESTS'] === 'true'
    ? await import('@telivityhaip/booking-requests/schema')
    : null;

  return db.transaction(async (tx) => {
    const [property] = await tx
      .select({ id: coreSchema.properties.id, name: coreSchema.properties.name })
      .from(coreSchema.properties)
      .where(eq(coreSchema.properties.id, propertyId))
      .limit(1);

    if (!property) {
      throw new Error(`Property ${propertyId} was not found`);
    }

    const propertyRows = await tx.select({ id: coreSchema.properties.id }).from(coreSchema.properties);
    const guestReferenceGroups = await Promise.all([
      tx.select({ guestId: coreSchema.bookings.guestId }).from(coreSchema.bookings)
        .where(eq(coreSchema.bookings.propertyId, propertyId)),
      tx.select({ guestId: coreSchema.reservations.guestId }).from(coreSchema.reservations)
        .where(eq(coreSchema.reservations.propertyId, propertyId)),
      tx.select({ guestId: coreSchema.reservationGuests.guestId }).from(coreSchema.reservationGuests)
        .where(eq(coreSchema.reservationGuests.propertyId, propertyId)),
      tx.select({ guestId: coreSchema.folios.guestId }).from(coreSchema.folios)
        .where(eq(coreSchema.folios.propertyId, propertyId)),
      tx.select({ guestId: coreSchema.lostAndFoundItems.guestId }).from(coreSchema.lostAndFoundItems)
        .where(eq(coreSchema.lostAndFoundItems.propertyId, propertyId)),
      tx.select({ guestId: coreSchema.serviceRequests.guestId }).from(coreSchema.serviceRequests)
        .where(eq(coreSchema.serviceRequests.propertyId, propertyId)),
      tx.select({ guestId: coreSchema.maintenanceTickets.guestId }).from(coreSchema.maintenanceTickets)
        .where(eq(coreSchema.maintenanceTickets.propertyId, propertyId)),
    ]);
    const candidateGuestIds = new Set<string>(
      guestReferenceGroups.flatMap((rows) => rows.map((row) => row.guestId).filter(isGuestId)),
    );

    if (propertyRows.length === 1) {
      const allGuests = await tx.select({ id: coreSchema.guests.id }).from(coreSchema.guests);
      allGuests.forEach((guest) => candidateGuestIds.add(guest.id));
    }

    const deleted: Record<string, number> = {};
    const remember = (name: string, rows: Array<{ id: string }>) => {
      deleted[name] = rows.length;
    };

    if (requestSchema) {
      remember('bookingRequestPaymentAllocations', await tx
        .delete(requestSchema.bookingRequestPaymentAllocations)
        .where(eq(requestSchema.bookingRequestPaymentAllocations.propertyId, propertyId))
        .returning({ id: requestSchema.bookingRequestPaymentAllocations.id }));
      remember('bookingRequestPaymentResolutions', await tx
        .delete(requestSchema.bookingRequestPaymentResolutions)
        .where(eq(requestSchema.bookingRequestPaymentResolutions.propertyId, propertyId))
        .returning({ id: requestSchema.bookingRequestPaymentResolutions.id }));
      remember('bookingRequestStayAmendments', await tx
        .delete(requestSchema.bookingRequestStayAmendments)
        .where(eq(requestSchema.bookingRequestStayAmendments.propertyId, propertyId))
        .returning({ id: requestSchema.bookingRequestStayAmendments.id }));
      remember('bookingRequestConsequences', await tx
        .delete(requestSchema.bookingRequestConsequences)
        .where(eq(requestSchema.bookingRequestConsequences.propertyId, propertyId))
        .returning({ id: requestSchema.bookingRequestConsequences.id }));
      remember('bookingRequestEmailDeliveries', await tx
        .delete(requestSchema.bookingRequestEmailDeliveries)
        .where(eq(requestSchema.bookingRequestEmailDeliveries.propertyId, propertyId))
        .returning({ id: requestSchema.bookingRequestEmailDeliveries.id }));
    }

    remember('depositLedgerEntries', await tx.delete(coreSchema.depositLedgerEntries)
      .where(eq(coreSchema.depositLedgerEntries.propertyId, propertyId))
      .returning({ id: coreSchema.depositLedgerEntries.id }));
    remember('folioInboundPosts', await tx.delete(coreSchema.folioInboundPosts)
      .where(eq(coreSchema.folioInboundPosts.propertyId, propertyId))
      .returning({ id: coreSchema.folioInboundPosts.id }));
    remember('fiscalDocuments', await tx.delete(coreSchema.fiscalDocuments)
      .where(eq(coreSchema.fiscalDocuments.propertyId, propertyId))
      .returning({ id: coreSchema.fiscalDocuments.id }));
    remember('folioRoutingRules', await tx.delete(coreSchema.folioRoutingRules)
      .where(eq(coreSchema.folioRoutingRules.propertyId, propertyId))
      .returning({ id: coreSchema.folioRoutingRules.id }));
    remember('loyaltyTransactions', await tx.delete(coreSchema.loyaltyTransactions)
      .where(eq(coreSchema.loyaltyTransactions.propertyId, propertyId))
      .returning({ id: coreSchema.loyaltyTransactions.id }));
    remember('arTransactions', await tx.delete(coreSchema.arTransactions)
      .where(eq(coreSchema.arTransactions.propertyId, propertyId))
      .returning({ id: coreSchema.arTransactions.id }));
    remember('reservationServices', await tx.delete(coreSchema.reservationServices)
      .where(eq(coreSchema.reservationServices.propertyId, propertyId))
      .returning({ id: coreSchema.reservationServices.id }));
    remember('doorLockCredentials', await tx.delete(coreSchema.doorLockCredentials)
      .where(eq(coreSchema.doorLockCredentials.propertyId, propertyId))
      .returning({ id: coreSchema.doorLockCredentials.id }));
    remember('roomingListEntries', await tx.delete(coreSchema.roomingListEntries)
      .where(eq(coreSchema.roomingListEntries.propertyId, propertyId))
      .returning({ id: coreSchema.roomingListEntries.id }));
    remember('waitlistEntries', await tx.delete(coreSchema.waitlistEntries)
      .where(eq(coreSchema.waitlistEntries.propertyId, propertyId))
      .returning({ id: coreSchema.waitlistEntries.id }));
    remember('guestReviews', await tx.delete(coreSchema.guestReviews)
      .where(eq(coreSchema.guestReviews.propertyId, propertyId))
      .returning({ id: coreSchema.guestReviews.id }));
    remember('lostAndFoundItems', await tx.delete(coreSchema.lostAndFoundItems)
      .where(eq(coreSchema.lostAndFoundItems.propertyId, propertyId))
      .returning({ id: coreSchema.lostAndFoundItems.id }));
    remember('serviceRequests', await tx.delete(coreSchema.serviceRequests)
      .where(eq(coreSchema.serviceRequests.propertyId, propertyId))
      .returning({ id: coreSchema.serviceRequests.id }));
    remember('maintenanceTickets', await tx.delete(coreSchema.maintenanceTickets)
      .where(eq(coreSchema.maintenanceTickets.propertyId, propertyId))
      .returning({ id: coreSchema.maintenanceTickets.id }));
    remember('roomDiscrepancyCases', await tx.delete(coreSchema.roomDiscrepancyCases)
      .where(eq(coreSchema.roomDiscrepancyCases.propertyId, propertyId))
      .returning({ id: coreSchema.roomDiscrepancyCases.id }));
    remember('housekeepingTasks', await tx.delete(coreSchema.housekeepingTasks)
      .where(eq(coreSchema.housekeepingTasks.propertyId, propertyId))
      .returning({ id: coreSchema.housekeepingTasks.id }));
    remember('cashMovements', await tx.delete(coreSchema.cashMovements)
      .where(eq(coreSchema.cashMovements.propertyId, propertyId))
      .returning({ id: coreSchema.cashMovements.id }));
    remember('cashDrawerSessions', await tx.delete(coreSchema.cashDrawerSessions)
      .where(eq(coreSchema.cashDrawerSessions.propertyId, propertyId))
      .returning({ id: coreSchema.cashDrawerSessions.id }));
    remember('webhookDeliveries', await tx.delete(coreSchema.webhookDeliveries)
      .where(eq(coreSchema.webhookDeliveries.propertyId, propertyId))
      .returning({ id: coreSchema.webhookDeliveries.id }));
    remember('icalBlocks', await tx.delete(coreSchema.icalBlocks)
      .where(eq(coreSchema.icalBlocks.propertyId, propertyId))
      .returning({ id: coreSchema.icalBlocks.id }));
    remember('rateRestrictions', await tx.delete(coreSchema.rateRestrictions)
      .where(eq(coreSchema.rateRestrictions.propertyId, propertyId))
      .returning({ id: coreSchema.rateRestrictions.id }));
    remember('reservationNotes', await tx.delete(coreSchema.reservationNotes)
      .where(eq(coreSchema.reservationNotes.propertyId, propertyId))
      .returning({ id: coreSchema.reservationNotes.id }));
    remember('reservationGuests', await tx.delete(coreSchema.reservationGuests)
      .where(eq(coreSchema.reservationGuests.propertyId, propertyId))
      .returning({ id: coreSchema.reservationGuests.id }));

    await tx.update(coreSchema.groupProfiles)
      .set({ masterFolioId: null, updatedAt: new Date() })
      .where(eq(coreSchema.groupProfiles.propertyId, propertyId));

    remember('payments', await tx.delete(coreSchema.payments)
      .where(eq(coreSchema.payments.propertyId, propertyId))
      .returning({ id: coreSchema.payments.id }));

    if (requestSchema) {
      remember('bookingRequestInstallments', await tx
        .delete(requestSchema.bookingRequestInstallments)
        .where(eq(requestSchema.bookingRequestInstallments.propertyId, propertyId))
        .returning({ id: requestSchema.bookingRequestInstallments.id }));
      remember('bookingRequests', await tx.delete(requestSchema.bookingRequests)
        .where(eq(requestSchema.bookingRequests.propertyId, propertyId))
        .returning({ id: requestSchema.bookingRequests.id }));
    }

    remember('charges', await tx.delete(coreSchema.charges)
      .where(eq(coreSchema.charges.propertyId, propertyId))
      .returning({ id: coreSchema.charges.id }));
    remember('folios', await tx.delete(coreSchema.folios)
      .where(eq(coreSchema.folios.propertyId, propertyId))
      .returning({ id: coreSchema.folios.id }));
    remember('reservations', await tx.delete(coreSchema.reservations)
      .where(eq(coreSchema.reservations.propertyId, propertyId))
      .returning({ id: coreSchema.reservations.id }));
    remember('bookings', await tx.delete(coreSchema.bookings)
      .where(eq(coreSchema.bookings.propertyId, propertyId))
      .returning({ id: coreSchema.bookings.id }));

    await tx.update(coreSchema.arLedgers)
      .set({ balance: '0.00', updatedAt: new Date() })
      .where(eq(coreSchema.arLedgers.propertyId, propertyId));
    await tx.update(coreSchema.icalFeeds)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(coreSchema.icalFeeds.propertyId, propertyId));

    const resetRooms = await tx.update(coreSchema.rooms)
      .set({
        status: 'guest_ready',
        hkOccupancy: 'vacant',
        hkObservedPersons: null,
        hkObservedAt: null,
        hkObservedBy: null,
        maintenanceNotes: null,
        isActive: true,
        updatedAt: new Date(),
      })
      .where(eq(coreSchema.rooms.propertyId, propertyId))
      .returning({ id: coreSchema.rooms.id });

    const candidateIds = [...candidateGuestIds];
    let guestsDeleted = 0;
    let guestsRetainedBecauseShared = 0;
    if (candidateIds.length > 0) {
      const remainingReferenceGroups = await Promise.all([
        tx.select({ guestId: coreSchema.bookings.guestId }).from(coreSchema.bookings)
          .where(inArray(coreSchema.bookings.guestId, candidateIds)),
        tx.select({ guestId: coreSchema.reservations.guestId }).from(coreSchema.reservations)
          .where(inArray(coreSchema.reservations.guestId, candidateIds)),
        tx.select({ guestId: coreSchema.reservationGuests.guestId }).from(coreSchema.reservationGuests)
          .where(inArray(coreSchema.reservationGuests.guestId, candidateIds)),
        tx.select({ guestId: coreSchema.folios.guestId }).from(coreSchema.folios)
          .where(inArray(coreSchema.folios.guestId, candidateIds)),
        tx.select({ guestId: coreSchema.lostAndFoundItems.guestId }).from(coreSchema.lostAndFoundItems)
          .where(inArray(coreSchema.lostAndFoundItems.guestId, candidateIds)),
        tx.select({ guestId: coreSchema.serviceRequests.guestId }).from(coreSchema.serviceRequests)
          .where(inArray(coreSchema.serviceRequests.guestId, candidateIds)),
        tx.select({ guestId: coreSchema.maintenanceTickets.guestId }).from(coreSchema.maintenanceTickets)
          .where(inArray(coreSchema.maintenanceTickets.guestId, candidateIds)),
      ]);
      const retainedGuestIds = new Set<string>(
        remainingReferenceGroups.flatMap((rows) => rows.map((row) => row.guestId).filter(isGuestId)),
      );
      const guestMergeRows = await tx
        .select({ id: coreSchema.guests.id, mergedIntoGuestId: coreSchema.guests.mergedIntoGuestId })
        .from(coreSchema.guests);
      const deletableGuestIds = new Set(candidateIds.filter((id) => !retainedGuestIds.has(id)));

      for (const row of guestMergeRows) {
        if (
          row.mergedIntoGuestId
          && deletableGuestIds.has(row.mergedIntoGuestId)
          && !deletableGuestIds.has(row.id)
        ) {
          deletableGuestIds.delete(row.mergedIntoGuestId);
          retainedGuestIds.add(row.mergedIntoGuestId);
        }
      }

      const deletableIds = [...deletableGuestIds];
      guestsRetainedBecauseShared = candidateIds.length - deletableIds.length;
      if (deletableIds.length > 0) {
        const loyaltyAccountRows = await tx
          .select({ id: coreSchema.loyaltyAccounts.id })
          .from(coreSchema.loyaltyAccounts)
          .where(inArray(coreSchema.loyaltyAccounts.guestId, deletableIds));
        const loyaltyAccountIds = loyaltyAccountRows.map((row) => row.id);
        if (loyaltyAccountIds.length > 0) {
          await tx.delete(coreSchema.loyaltyTransactions)
            .where(inArray(coreSchema.loyaltyTransactions.accountId, loyaltyAccountIds));
          await tx.delete(coreSchema.loyaltyAccounts)
            .where(inArray(coreSchema.loyaltyAccounts.id, loyaltyAccountIds));
        }
        const removedGuests = await tx.delete(coreSchema.guests)
          .where(inArray(coreSchema.guests.id, deletableIds))
          .returning({ id: coreSchema.guests.id });
        guestsDeleted = removedGuests.length;
      }
    }

    return {
      propertyId,
      propertyName: property.name,
      deleted,
      roomsReset: resetRooms.length,
      guestsDeleted,
      guestsRetainedBecauseShared,
    };
  });
}

async function main() {
  const config = readDemoResetConfig();
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const client = postgres(databaseUrl, postgresOptionsFromEnv());
  const db = drizzle(client, { schema: coreSchema });
  try {
    const preview = await propertyPreview(db, config.propertyId);
    console.log(JSON.stringify({ mode: config.execute ? 'execute' : 'preview', ...preview }, null, 2));

    if (!config.execute) {
      console.log(`Preview only. To execute, set DEMO_RESET_CONFIRM=${config.expectedConfirmation}`);
      return;
    }

    const summary = await resetDemoProperty(db, config.propertyId);
    console.log(JSON.stringify({ mode: 'complete', ...summary }, null, 2));
  } finally {
    await client.end();
  }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    console.error('Demo reset failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

export { propertyPreview, resetDemoProperty, demoResetConfirmation };
