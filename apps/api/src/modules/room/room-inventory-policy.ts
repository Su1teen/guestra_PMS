import { and, eq, inArray, lt, ne } from 'drizzle-orm';
import { roomInventoryBlocks } from '@telivityhaip/database';

/** Existing PMS semantics: OOO and OOS both exclude sales; their operational kinds remain distinct.
 * Expected end is a deadline, never permission to sell. An active block covers nights from start
 * until an authorized return, including future nights after the expected end. Physical room status
 * is a separate fact and is not changed by a planned interval or a clock/cron job.
 */
export function activeInventoryBlockConditions(
  propertyId: string,
  departureExclusive: string,
  roomIds?: string[],
  excludeId?: string,
) {
  return and(
    eq(roomInventoryBlocks.propertyId, propertyId),
    eq(roomInventoryBlocks.status, 'active'),
    lt(roomInventoryBlocks.startDate, departureExclusive),
    roomIds ? inArray(roomInventoryBlocks.roomId, roomIds) : undefined,
    excludeId ? ne(roomInventoryBlocks.id, excludeId) : undefined,
  );
}

export function dayAfter(date: string) {
  return new Date(Date.parse(date + 'T00:00:00Z') + 86400000)
    .toISOString()
    .slice(0, 10);
}
