/**
 * LES demo dataset — a believable operating history for a demo property, so every report, the tape
 * chart and the price calendar show real-looking figures.
 *
 *   tsx src/seed-les-demo.ts --profile borovoe|astana --property <uuid> [--today 2026-11-24] [--from 2026-08-01]
 *                            [--ahead 45] [--manifest crm-links.json] [--confirm-demo]
 *
 * What it does, for ONE property (all writes are scoped by property_id):
 *  1. Catalog: room categories, rooms and base rates of the profile (LES Borovoe accommodation names and
 *     prices as in the CRM catalog; LES Astana city rooms). Other categories, rooms and rates of the
 *     property are deactivated, never deleted.
 *  2. Removes the previous run of this script (its confirmation prefix) and, for the original demo
 *     property, the old generic seed stays. Stays created through the API are left alone.
 *  3. Generates stays from --from to today + --ahead: guests, bookings, folios, nightly room charges,
 *     package meals with cost, outlet charges (restaurant, bar, SPA, bath, activities), prepayments,
 *     balance payments, cancellations with refunds or retained prepayments, no-shows, complimentary
 *     stays, walk-in outlet sales on a house account, and a daily plan and expenses per month.
 *  4. Writes a manifest of the stays that CRM managers closed, for the CRM side of the demo.
 *
 * It refuses to run without --confirm-demo: the data is invented and only belongs on demo properties.
 */
import { writeFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, getTableColumns, inArray, is, like, notInArray, or } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as schema from './schema/index.js';
import { postgresOptionsFromEnv } from './postgres-options.js';

type Profile = 'borovoe' | 'astana';
interface CategoryDef { code: string; name: string; capacity: number; adults: number; beds: number; count: number; numbers: string[]; rate: number; amenities: string[] }

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i]!;
  if (!key.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next && !next.startsWith('--')) { args.set(key.slice(2), next); i++; } else args.set(key.slice(2), 'true');
}
const profile = (args.get('profile') ?? 'borovoe') as Profile;
const propertyId = args.get('property') ?? '';
const today = args.get('today') ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const from = args.get('from') ?? '2026-08-01';
const ahead = Number(args.get('ahead') ?? 45);
const CURRENCY = 'KZT';
const TZ_OFFSET = '+05:00';

const range = (n: number, start: number, prefix = '') => Array.from({ length: n }, (_, i) => `${prefix}${start + i}`);
const CATALOG: Record<Profile, CategoryDef[]> = {
  // Names and prices as in the CRM catalog of LES Borovoe (official accommodation page); unit numbers are demo labels.
  borovoe: [
    { code: 'AFR', name: 'A-Frame', capacity: 4, adults: 4, beds: 2, count: 5, numbers: range(5, 101, 'A-'), rate: 130000, amenities: ['wifi', 'tv', 'minibar', 'terrace', 'fireplace'] },
    { code: 'NEST', name: 'Nest House', capacity: 4, adults: 2, beds: 2, count: 5, numbers: range(5, 201, 'N-'), rate: 210000, amenities: ['wifi', 'tv', 'minibar', 'terrace'] },
    { code: 'GLASS', name: 'Glass House', capacity: 4, adults: 2, beds: 2, count: 5, numbers: range(5, 301, 'G-'), rate: 135000, amenities: ['wifi', 'tv', 'minibar', 'terrace'] },
    { code: 'FOR2', name: 'Forest House · 2-местный номер', capacity: 2, adults: 2, beds: 1, count: 2, numbers: ['F-401', 'F-402'], rate: 135000, amenities: ['wifi', 'tv', 'minibar', 'terrace'] },
    { code: 'FOR6', name: 'Forest House · 6-местный номер', capacity: 6, adults: 6, beds: 3, count: 1, numbers: ['F-403'], rate: 245000, amenities: ['wifi', 'tv', 'minibar', 'terrace', 'living_area'] },
  ],
  // Categories and prices as in the CRM catalog of LES Astana.
  astana: [
    { code: 'DLX', name: 'Делюкс-номер', capacity: 2, adults: 2, beds: 1, count: 14, numbers: range(14, 201), rate: 90000, amenities: ['wifi', 'tv', 'minibar'] },
    { code: 'LUX', name: 'Люкс', capacity: 3, adults: 2, beds: 1, count: 6, numbers: range(6, 301), rate: 165000, amenities: ['wifi', 'tv', 'minibar', 'living_area'] },
  ],
};
const PREFIX: Record<Profile, string> = { borovoe: 'LB', astana: 'LA' };
const BREAKFAST = { price: 7000, cost: 4000 };

const FIRST_F = ['Айгерим', 'Дана', 'Алия', 'Мадина', 'Асель', 'Динара', 'Камила', 'Жанар', 'Сауле', 'Анна', 'Екатерина', 'Ольга', 'Мария', 'Гульнара', 'Томирис', 'Аружан', 'Инкар', 'Виктория'];
const FIRST_M = ['Ерлан', 'Нурлан', 'Арман', 'Данияр', 'Тимур', 'Руслан', 'Санжар', 'Айдар', 'Бауыржан', 'Алексей', 'Дмитрий', 'Сергей', 'Максим', 'Ержан', 'Асхат', 'Марат', 'Олжас', 'Ильяс'];
const LAST = ['Сериков', 'Ахметов', 'Нурланов', 'Касымов', 'Жумабаев', 'Омаров', 'Абдрахманов', 'Исмаилов', 'Садыков', 'Тулегенов', 'Бекенов', 'Иванов', 'Петров', 'Ким', 'Смагулов', 'Мухамедов', 'Ержанов', 'Сагинтаев', 'Байжанов', 'Кузнецов'];
const feminine = (last: string) => /(ов|ев|ин)$/.test(last) ? `${last}а` : last;

/** Deterministic pseudo-random numbers, seeded per property so a re-run gives the same history. */
let state = [...propertyId].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
const rand = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)]!;
const between = (min: number, max: number) => Math.round(min + rand() * (max - min));
const chance = (p: number) => rand() < p;
const round = (value: number, step = 1000) => Math.round(value / step) * step;

/** Deterministic UUID inside a namespace of this script: <tag>-<property prefix>-4<n>. */
const ns = propertyId.replace(/-/g, '').slice(0, 4);
const uid = (tag: string, n: number) => `${tag.padEnd(8, '0').slice(0, 8)}-${ns}-4${(n >> 32).toString(16).padStart(3, '0').slice(-3)}-8${(Math.floor(n / 4096) % 4096).toString(16).padStart(3, '0')}-${(n % 4096).toString(16).padStart(4, '0')}${'0'.repeat(8)}`;
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dayOfWeek = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const local = (date: string, hh: number, mm = 0) => new Date(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00${TZ_OFFSET}`);
const service = (date: string) => new Date(`${date}T12:00:00Z`);
const amount = (value: number) => value.toFixed(2);

async function chunked<T>(rows: T[], size: number, run: (part: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += size) await run(rows.slice(i, i + size));
}

/**
 * Deletes stays and everything that hangs off them. Child tables are found from the schema (any column
 * pointing at a stay, booking, folio, charge or payment) and retried in savepoints until foreign keys allow.
 */
async function purge(db: any, ids: { reservations: string[]; bookings: string[]; folios: string[] }) {
  if (!ids.reservations.length && !ids.bookings.length && !ids.folios.length) return;
  const chargeIds: string[] = [], paymentIds: string[] = [];
  await chunked(ids.folios, 2000, async (part) => {
    chargeIds.push(...(await db.select({ id: schema.charges.id }).from(schema.charges).where(and(eq(schema.charges.propertyId, propertyId), inArray(schema.charges.folioId, part)))).map((r: any) => r.id));
    paymentIds.push(...(await db.select({ id: schema.payments.id }).from(schema.payments).where(and(eq(schema.payments.propertyId, propertyId), inArray(schema.payments.folioId, part)))).map((r: any) => r.id));
  });
  const sets: Record<string, string[]> = { reservationId: ids.reservations, convertedReservationId: ids.reservations, bookingId: ids.bookings,
    folioId: ids.folios, sourceFolioId: ids.folios, targetFolioId: ids.folios, masterFolioId: ids.folios,
    chargeId: chargeIds, originalChargeId: chargeIds, parentChargeId: chargeIds, paymentId: paymentIds, originalPaymentId: paymentIds };
  const own = new Map<unknown, string[]>([[schema.charges, chargeIds], [schema.payments, paymentIds], [schema.folios, ids.folios],
    [schema.reservations, ids.reservations], [schema.bookings, ids.bookings]]);
  const tables = Object.values(schema).filter((value) => is(value, PgTable)) as PgTable[];
  let pending = tables;
  for (let pass = 0; pass < 12 && pending.length; pass++) {
    const failed: PgTable[] = [];
    for (const table of pending) {
      const columns = getTableColumns(table) as Record<string, any>;
      const jobs: [any, string[]][] = Object.entries(sets).filter(([key, list]) => columns[key] && list.length).map(([key, list]) => [columns[key], list]);
      if (own.has(table) && own.get(table)!.length) jobs.push([columns['id'], own.get(table)!]);
      if (!jobs.length) continue;
      try {
        await db.transaction(async (tx: any) => {
          for (const [column, list] of jobs) await chunked(list, 2000, (part) => tx.delete(table).where(and(columns['propertyId'] ? eq(columns['propertyId'], propertyId) : undefined, inArray(column, part))));
        });
      } catch { failed.push(table); }
    }
    if (failed.length === pending.length) throw new Error(`PURGE_BLOCKED: ${failed.length} tables still referenced`);
    pending = failed;
  }
}

async function main() {
  if (args.get('confirm-demo') !== 'true') throw new Error('Refusing to write invented data without --confirm-demo');
  if (!/^[0-9a-f-]{36}$/.test(propertyId)) throw new Error('--property <uuid> is required');
  if (!CATALOG[profile]) throw new Error('--profile borovoe|astana');
  const client = postgres(process.env['DATABASE_URL'] ?? 'postgresql://haip:haip@localhost:5432/haip', postgresOptionsFromEnv());
  const db = drizzle(client, { schema });

  // ---------------------------------------------------------------- property
  let [property] = await db.select().from(schema.properties).where(eq(schema.properties.id, propertyId));
  if (!property) {
    if (profile !== 'astana') throw new Error('Property not found');
    [property] = await db.insert(schema.properties).values({ id: propertyId, name: 'ЛЕС Астана', code: 'LES-AST', description: 'Городской отель сети ЛЕС.',
      city: 'Астана', countryCode: 'KZ', timezone: 'Asia/Almaty', currencyCode: CURRENCY, defaultLanguage: 'ru', totalRooms: 20, checkInTime: '14:00',
      checkOutTime: '12:00', nightAuditTime: '02:00', settings: { commissionRatePercent: 10 } } as any).returning();
    console.log('Created property ЛЕС Астана');
  }
  if (property!.currencyCode !== CURRENCY) throw new Error('Property currency must be KZT');

  // ---------------------------------------------------------------- catalog
  const catalog = CATALOG[profile];
  const existingTypes = await db.select().from(schema.roomTypes).where(eq(schema.roomTypes.propertyId, propertyId));
  const typeIds: Record<string, string> = {};
  for (const [index, c] of catalog.entries()) {
    const found = existingTypes.find((t: any) => t.code === c.code);
    const values = { name: c.name, maxOccupancy: c.capacity, defaultOccupancy: Math.min(2, c.capacity), bedType: 'double', bedCount: c.beds, amenities: c.amenities, sortOrder: index + 1, isActive: true };
    if (found) { await db.update(schema.roomTypes).set(values as any).where(and(eq(schema.roomTypes.id, found.id), eq(schema.roomTypes.propertyId, propertyId))); typeIds[c.code] = found.id; }
    else { const [row] = await db.insert(schema.roomTypes).values({ id: uid('de000001', index + 1), propertyId, code: c.code, ...values } as any).returning(); typeIds[c.code] = row!.id; }
  }
  const activeTypeIds = Object.values(typeIds);
  await db.update(schema.roomTypes).set({ isActive: false } as any).where(and(eq(schema.roomTypes.propertyId, propertyId), notInArray(schema.roomTypes.id, activeTypeIds)));

  const existingRooms = await db.select().from(schema.rooms).where(eq(schema.rooms.propertyId, propertyId));
  const roomList: { id: string; number: string; code: string }[] = [];
  let roomIndex = 0;
  for (const c of catalog) for (const number of c.numbers) {
    roomIndex++;
    const found = existingRooms.find((r: any) => r.number === number);
    const values = { roomTypeId: typeIds[c.code]!, floor: number.replace(/\D/g, '').slice(0, 1) || '1', building: profile === 'astana' ? 'Главный корпус' : 'Лес', isActive: true, status: 'vacant_clean' };
    if (found) { await db.update(schema.rooms).set(values as any).where(and(eq(schema.rooms.id, found.id), eq(schema.rooms.propertyId, propertyId))); roomList.push({ id: found.id, number, code: c.code }); }
    else { const [row] = await db.insert(schema.rooms).values({ id: uid('de100001', roomIndex), propertyId, number, ...values } as any).returning(); roomList.push({ id: row!.id, number, code: c.code }); }
  }
  await db.update(schema.rooms).set({ isActive: false } as any).where(and(eq(schema.rooms.propertyId, propertyId), notInArray(schema.rooms.id, roomList.map((r) => r.id))));

  let [policy] = await db.select().from(schema.cancellationPolicies).where(and(eq(schema.cancellationPolicies.propertyId, propertyId), eq(schema.cancellationPolicies.code, 'LES-24')));
  if (!policy) [policy] = await db.insert(schema.cancellationPolicies).values({ id: uid('de200001', 1), propertyId, name: 'Отмена за 24 часа', code: 'LES-24',
    description: 'Бесплатная отмена не позднее чем за 24 часа до заезда; позже предоплата удерживается.', freeCancelHoursBeforeArrival: 24,
    penaltyType: 'first_night', depositHandling: 'refund_if_refundable', isActive: true } as any).returning();
  const existingPlans = await db.select().from(schema.ratePlans).where(eq(schema.ratePlans.propertyId, propertyId));
  const planIds: Record<string, { bar: string; bb: string | null }> = {};
  let planIndex = 0;
  for (const c of catalog) {
    const defs = [{ code: `${c.code}-BAR`, name: `${c.name} — без питания`, base: c.rate, meal: 'room_only', type: 'bar' },
      ...(profile === 'borovoe' ? [{ code: `${c.code}-BB`, name: `${c.name} — с завтраками`, base: c.rate + 2 * BREAKFAST.price, meal: 'breakfast', type: 'package' }] : [])];
    const ids: string[] = [];
    for (const def of defs) {
      planIndex++;
      const found = existingPlans.find((p: any) => p.code === def.code);
      const values = { roomTypeId: typeIds[c.code]!, name: def.name, type: def.type, baseAmount: amount(def.base), currencyCode: CURRENCY, mealPlan: def.meal,
        cancellationPolicyId: policy!.id, isActive: true, validFrom: null, validTo: null, channelCodes: null, sortOrder: planIndex };
      if (found) { await db.update(schema.ratePlans).set(values as any).where(and(eq(schema.ratePlans.id, found.id), eq(schema.ratePlans.propertyId, propertyId))); ids.push(found.id); }
      else { const [row] = await db.insert(schema.ratePlans).values({ id: uid('de300001', planIndex), propertyId, code: def.code, ...values } as any).returning(); ids.push(row!.id); }
    }
    planIds[c.code] = { bar: ids[0]!, bb: ids[1] ?? null };
  }
  const activePlanIds = Object.values(planIds).flatMap((p) => [p.bar, p.bb]).filter((v): v is string => Boolean(v));
  await db.update(schema.ratePlans).set({ isActive: false } as any).where(and(eq(schema.ratePlans.propertyId, propertyId), notInArray(schema.ratePlans.id, activePlanIds)));
  // Old demo weekend surcharges and minimum stays would make quotes disagree with the published prices.
  await db.delete(schema.rateRestrictions).where(and(eq(schema.rateRestrictions.propertyId, propertyId), inArray(schema.rateRestrictions.ratePlanId, activePlanIds)));
  console.log(`Catalog: ${catalog.length} categories, ${roomList.length} rooms, ${activePlanIds.length} rates`);

  // ---------------------------------------------------------------- remove previous demo
  const prefix = PREFIX[profile];
  const oldBookings = await db.select({ id: schema.bookings.id }).from(schema.bookings).where(and(eq(schema.bookings.propertyId, propertyId),
    or(like(schema.bookings.confirmationNumber, `${prefix}-%`), like(schema.bookings.confirmationNumber, 'LES-2025%'))));
  const bookingIds = oldBookings.map((b: any) => b.id);
  const oldStays = bookingIds.length ? (await Promise.all(chunk(bookingIds).map((part) => db.select({ id: schema.reservations.id }).from(schema.reservations)
    .where(and(eq(schema.reservations.propertyId, propertyId), inArray(schema.reservations.bookingId, part)))))).flat() : [];
  const oldFolios = bookingIds.length ? (await Promise.all(chunk(bookingIds).map((part) => db.select({ id: schema.folios.id }).from(schema.folios)
    .where(and(eq(schema.folios.propertyId, propertyId), inArray(schema.folios.bookingId, part)))))).flat() : [];
  await purge(db, { reservations: oldStays.map((r: any) => r.id), bookings: bookingIds, folios: oldFolios.map((f: any) => f.id) });
  const walkInName = 'Гости без проживания (демо)';
  const oldAccounts = await db.select({ id: schema.houseAccounts.id }).from(schema.houseAccounts).where(and(eq(schema.houseAccounts.propertyId, propertyId), eq(schema.houseAccounts.name, walkInName)));
  for (const account of oldAccounts) {
    await db.delete(schema.payments).where(and(eq(schema.payments.propertyId, propertyId), eq(schema.payments.houseAccountId, account.id)));
    await db.delete(schema.charges).where(and(eq(schema.charges.propertyId, propertyId), eq(schema.charges.houseAccountId, account.id)));
    await db.delete(schema.houseAccounts).where(and(eq(schema.houseAccounts.id, account.id), eq(schema.houseAccounts.propertyId, propertyId)));
  }
  await db.delete(schema.managementInputs).where(and(eq(schema.managementInputs.propertyId, propertyId), eq(schema.managementInputs.reason, 'Демо-данные')));
  // A stale closed night audit would pin the reports' business date in the past.
  await db.delete(schema.auditRuns).where(eq(schema.auditRuns.propertyId, propertyId));
  await db.delete(schema.integrationLinks).where(and(eq(schema.integrationLinks.propertyId, propertyId), like(schema.integrationLinks.externalEntityId, 'res_demo_%')));
  console.log(`Removed previous demo: ${bookingIds.length} bookings`);

  // ---------------------------------------------------------------- guests
  const guestCount = profile === 'borovoe' ? 260 : 220;
  const guestRows = Array.from({ length: guestCount }, (_, i) => {
    const female = chance(0.5);
    const last = pick(LAST);
    return { id: uid('de400001', i + 1), firstName: female ? pick(FIRST_F) : pick(FIRST_M), lastName: female ? feminine(last) : last,
      phone: `+7 70${between(0, 8)} 0${between(10, 99)} ${between(10, 99)} ${String(i % 100).padStart(2, '0')}`, email: null, nationality: 'KZ',
      vipLevel: chance(0.06) ? 'gold' : 'none', companyName: chance(0.12) ? pick(['Qazaq Group', 'KazMunayGas', 'Halyk Bank', 'Kaspi.kz', 'Air Astana', 'BI Group']) : null,
      gdprConsentMarketing: chance(0.6) };
  });
  await chunked(guestRows, 500, (part) => db.insert(schema.guests).values(part as any).onConflictDoNothing());
  if (propertyId === 'a0000001-0000-4000-a000-000000000001') {
    // The original generic demo guests get local names (their rows are linked from reviews and other demo data).
    for (let i = 1; i <= 15; i++) {
      const g = guestRows[i]!;
      await db.update(schema.guests).set({ firstName: g.firstName, lastName: g.lastName, phone: g.phone, email: null, nationality: 'KZ' } as any)
        .where(eq(schema.guests.id, `e0000001-0000-4000-a000-${i.toString(16).padStart(12, '0')}`));
    }
  }

  // ---------------------------------------------------------------- stays
  const end = addDays(today, ahead);
  const rows = { bookings: [] as any[], reservations: [] as any[], folios: [] as any[], charges: [] as any[], payments: [] as any[], allocations: [] as any[] };
  const manifest: any[] = [];
  const dailyActual = new Map<string, Record<string, number>>();
  const addActual = (date: string, article: string, value: number) => {
    const day = dailyActual.get(date) ?? {}; day[article] = (day[article] ?? 0) + value; dailyActual.set(date, day);
  };
  let seq = 0, chargeSeq = 0, paymentSeq = 0;
  const now = new Date();
  const outlets = profile === 'borovoe'
    ? [{ p: 0.45, type: 'food_beverage', outlet: 'Ресторан SOVA', text: 'Ужин', min: 9000, max: 16000, perGuest: true },
       { p: 0.25, type: 'food_beverage', outlet: 'Лобби-бар', text: 'Бар', min: 5000, max: 18000, perGuest: false },
       { p: 0.10, type: 'minibar', outlet: 'Мини-бар', text: 'Мини-бар', min: 3000, max: 9000, perGuest: false },
       { p: 0.18, type: 'spa', outlet: 'SPA', text: 'SPA визит', min: 12000, max: 12000, perGuest: true },
       { p: 0.10, type: 'spa', outlet: 'SPA', text: 'Массаж 60 минут', min: 15000, max: 15000, perGuest: false },
       { p: 0.22, type: 'bath', outlet: 'Баня и чан', text: 'Баня и чан, 2 часа', min: 50000, max: 50000, perGuest: false },
       { p: 0.08, type: 'entertainment', outlet: 'Конные прогулки', text: 'Конная прогулка', min: 10000, max: 10000, perGuest: true },
       { p: 0.07, type: 'entertainment', outlet: 'Квадроциклы', text: 'Квадроциклы', min: 15000, max: 30000, perGuest: false },
       { p: 0.06, type: 'entertainment', outlet: 'Караоке', text: 'Караоке, 2 часа', min: 30000, max: 30000, perGuest: false }]
    : [{ p: 0.40, type: 'food_beverage', outlet: 'Ресторан SOVA', text: 'Ужин', min: 9000, max: 16000, perGuest: true },
       { p: 0.35, type: 'food_beverage', outlet: 'Ресторан SOVA', text: 'Завтрак', min: 6000, max: 6000, perGuest: true },
       { p: 0.30, type: 'food_beverage', outlet: 'Лобби-бар', text: 'Бар', min: 5000, max: 20000, perGuest: false },
       { p: 0.12, type: 'minibar', outlet: 'Мини-бар', text: 'Мини-бар', min: 3000, max: 9000, perGuest: false },
       { p: 0.15, type: 'spa', outlet: 'SPA', text: 'SPA визит', min: 12000, max: 12000, perGuest: true },
       { p: 0.08, type: 'spa', outlet: 'SPA', text: 'Массаж 60 минут', min: 15000, max: 15000, perGuest: false },
       { p: 0.06, type: 'bath', outlet: 'Баня и чан', text: 'Баня и чан, 2 часа', min: 50000, max: 50000, perGuest: false },
       { p: 0.05, type: 'entertainment', outlet: 'Караоке', text: 'Караоке, 2 часа', min: 30000, max: 30000, perGuest: false },
       { p: 0.05, type: 'laundry', outlet: 'Прачечная', text: 'Стирка и глажка', min: 4000, max: 12000, perGuest: false }];
  const articleOf: Record<string, string> = { food_beverage: 'food_beverage', minibar: 'minibar', spa: 'spa', bath: 'bath', entertainment: 'entertainment', laundry: 'laundry' };

  for (const room of roomList) {
    const category = catalog.find((c) => c.code === room.code)!;
    let day = from;
    while (day < end) {
      const dow = dayOfWeek(day);
      const weekend = dow === 5 || dow === 6;
      const festive = day >= '2026-12-25' || day <= '2027-01-08';
      const startP = profile === 'borovoe' ? (weekend ? 0.75 : 0.32) : (weekend ? 0.35 : 0.6);
      const futureFade = day > today ? Math.max(0.25, 1 - (Date.parse(day) - Date.parse(today)) / (ahead * 86_400_000)) : 1;
      if (!chance(startP * futureFade)) { day = addDays(day, 1); continue; }
      const nights = profile === 'borovoe' ? (weekend ? pick([2, 2, 1, 3]) : pick([1, 2, 2, 3, 4])) : pick([1, 1, 2, 2, 3, 4]);
      const arrival = day, departure = addDays(day, nights);
      day = addDays(departure, chance(0.3) ? 1 : 0);
      seq++;
      const id = uid('de500001', seq), bookingId = uid('de510001', seq), folioId = uid('de520001', seq);
      const conf = `${prefix}-${String(26000 + seq)}`;
      const guest = guestRows[Math.floor(rand() * guestRows.length)]!;
      const adults = Math.max(1, Math.min(category.adults, pick([1, 2, 2, 2, 3, 4])));
      const children = category.capacity > adults && chance(0.35) ? between(1, Math.min(2, category.capacity - adults)) : 0;
      const breakfast = profile === 'borovoe' && chance(0.35);
      const nightly = Array.from({ length: nights }, (_, n) => {
        const date = addDays(arrival, n); const d = dayOfWeek(date);
        return round(category.rate * (d === 5 || d === 6 ? 1.2 : 1) * (date >= '2026-12-25' || date <= '2027-01-08' ? 1.3 : 1) + (breakfast ? BREAKFAST.price * adults : 0));
      });
      const priceType = chance(0.015) ? 'complimentary' : chance(0.01) ? 'barter' : 'standard';
      const total = priceType === 'standard' ? nightly.reduce((s, v) => s + v, 0) : 0;
      const fnbTotal = breakfast && priceType === 'standard' ? BREAKFAST.price * adults * nights : 0;
      const sourceRoll = rand();
      const source = profile === 'borovoe'
        ? (sourceRoll < 0.3 ? 'direct' : sourceRoll < 0.55 ? 'phone' : sourceRoll < 0.8 ? 'ota' : sourceRoll < 0.92 ? 'corporate' : 'walk_in')
        : (sourceRoll < 0.2 ? 'direct' : sourceRoll < 0.35 ? 'phone' : sourceRoll < 0.65 ? 'ota' : sourceRoll < 0.92 ? 'corporate' : 'walk_in');
      const lead = source === 'walk_in' ? 0 : between(1, 30);
      let createdAt = local(addDays(arrival, -lead), between(9, 21), between(0, 59));
      if (createdAt > now) createdAt = new Date(now.getTime() - between(30, 600) * 60_000);
      const past = arrival <= today;
      let status = departure <= today ? 'checked_out' : past ? 'checked_in' : 'confirmed';
      if (chance(0.07)) status = 'cancelled';
      else if (past && chance(0.02)) status = 'no_show';
      if (status === 'checked_in' && arrival === today && chance(0.4)) status = 'confirmed';
      const crm = (source === 'direct' || source === 'phone' || source === 'corporate') && chance(0.75);
      const channelCode = source === 'ota' ? pick(['booking_com', 'booking_com', 'ostrovok']) : crm ? 'guestra_crm' : source === 'direct' ? 'booking_engine' : null;
      const cancelledAt = status === 'cancelled' ? new Date(Math.min(local(addDays(arrival, -between(0, Math.max(1, lead))), between(9, 20)).getTime(), now.getTime() - 3_600_000)) : null;
      rows.bookings.push({ id: bookingId, propertyId, guestId: guest.id, confirmationNumber: conf, source, channelCode, createdAt, updatedAt: createdAt });
      rows.reservations.push({ id, propertyId, bookingId, guestId: guest.id, arrivalDate: arrival, departureDate: departure, nights, roomTypeId: typeIds[category.code],
        roomId: status === 'cancelled' ? null : room.id, status, ratePlanId: breakfast ? planIds[category.code]!.bb : planIds[category.code]!.bar, totalAmount: amount(total),
        currencyCode: CURRENCY, adults, children, priceType, priceTypeReason: priceType === 'standard' ? null : priceType === 'barter' ? 'Бартер с блогером' : 'Комплимент от управляющего',
        checkedInAt: ['checked_in', 'checked_out'].includes(status) ? local(arrival, between(14, 18), between(0, 59)) : null,
        checkedOutAt: status === 'checked_out' ? local(departure, between(9, 12), between(0, 59)) : null,
        cancelledAt, cancellationReason: cancelledAt ? pick(['Изменились планы', 'Перенос поездки', 'Болезнь', 'Нашли другой вариант']) : null,
        createdAt, updatedAt: createdAt });
      if (fnbTotal) rows.allocations.push(
        { propertyId, reservationId: id, kind: 'snapshot', category: 'accommodation', description: 'Проживание', amount: amount(total - fnbTotal), cost: '0', currencyCode: CURRENCY, occurredAt: createdAt },
        { propertyId, reservationId: id, kind: 'snapshot', category: 'fnb', description: 'Завтраки', quantity: adults * nights, amount: amount(fnbTotal),
          cost: amount(BREAKFAST.cost * adults * nights), currencyCode: CURRENCY, occurredAt: createdAt });
      const managed = crm && status !== 'cancelled' ? pick([0, 1, 2, 2, null]) : null;
      if (crm) {
        // CRM sync links the stay to its CRM copy; the CRM demo script attaches the closing manager to that copy.
        manifest.push({ pmsReservationId: id, confirmationNumber: conf, guest: { firstName: guest.firstName, lastName: guest.lastName, phone: guest.phone },
          arrival, departure, nights, roomType: category.name, roomNumber: room.number, adults, children, total, status, source, createdAt: createdAt.toISOString(), manager: managed });
      }

      // Folio, postings and payments.
      const folioCharges: any[] = [], folioPayments: any[] = [];
      const charge = (date: string, type: string, description: string, value: number, outlet: string | null = null) => {
        folioCharges.push({ id: uid('de530001', ++chargeSeq), propertyId, folioId, type, description, amount: amount(value), currencyCode: CURRENCY, outlet,
          taxAmount: '0', serviceDate: service(date), isLocked: date < today, postedAt: local(date, 23, 30) });
        addActual(date, type === 'room' ? 'room' : type === 'package' ? 'package' : articleOf[type] ?? type, value);
      };
      const pay = (at: Date, value: number, method: string, note?: string) => {
        const row = { id: uid('de540001', ++paymentSeq), propertyId, folioId, method, status: 'captured', amount: amount(value), currencyCode: CURRENCY,
          gatewayProvider: method === 'other' ? 'kaspi' : null, notes: note ?? null, processedAt: at, createdAt: at, updatedAt: at };
        folioPayments.push(row); return row;
      };
      const method = () => { const r = rand(); return r < 0.55 ? 'other' : r < 0.8 ? 'bank_transfer' : r < 0.93 ? 'credit_card' : 'cash'; };
      const stayedNights = status === 'checked_out' ? nights : status === 'checked_in' ? Math.max(0, Math.round((Date.parse(today) - Date.parse(arrival)) / 86_400_000)) : 0;
      if (priceType === 'standard') for (let n = 0; n < stayedNights; n++) {
        const date = addDays(arrival, n);
        const meals = breakfast ? BREAKFAST.price * adults : 0;
        charge(date, 'room', `Проживание ${room.number}, ночь ${n + 1}`, nightly[n]! - meals);
        if (meals) charge(addDays(date, 1), 'package', `Завтраки в пакете, ${adults} гост.`, meals);
      }
      if (['checked_in', 'checked_out'].includes(status)) for (let n = 0; n < Math.max(1, stayedNights); n++) {
        const date = addDays(arrival, n);
        if (date > today) break;
        for (const o of outlets) if (chance(o.p)) {
          const value = round(between(o.min, o.max) * (o.perGuest ? adults + children * 0.5 : 1), 500);
          charge(date, o.type, o.text, value, o.outlet);
        }
      }
      const prepaid = source !== 'ota' && source !== 'walk_in' && priceType === 'standard' && total > 0;
      const prepayAt = new Date(Math.min(createdAt.getTime() + between(10, 300) * 60_000, now.getTime() - 60_000));
      let prepayment: any = null;
      if (prepaid && (status !== 'cancelled' || chance(0.7))) prepayment = pay(prepayAt, round(total * 0.5), method(), 'Предоплата 50%');
      if (status === 'cancelled' || status === 'no_show') {
        if (prepayment) {
          const late = status === 'no_show' || (cancelledAt && Date.parse(`${arrival}T14:00:00${TZ_OFFSET}`) - cancelledAt.getTime() < 24 * 3_600_000) || chance(0.25);
          const at = cancelledAt ?? local(addDays(arrival, 1), 10);
          if (late) {
            const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
            charge(date, 'fee', 'Штраф: удержание предоплаты (поздняя отмена)', Number(prepayment.amount));
            rows.allocations.push({ propertyId, reservationId: id, kind: 'penalty', category: 'penalty', description: 'Удержанная предоплата', amount: prepayment.amount,
              cost: '0', currencyCode: CURRENCY, reason: status === 'no_show' ? 'Незаезд' : 'Отмена позже чем за 24 часа', occurredAt: at });
          } else {
            prepayment.status = 'refunded';
            const refundAt = new Date(Math.min(at.getTime() + 3_600_000, now.getTime() - 60_000));
            folioPayments.push({ id: uid('de540001', ++paymentSeq), propertyId, folioId, method: prepayment.method, status: 'captured', amount: amount(-Number(prepayment.amount)),
              currencyCode: CURRENCY, originalPaymentId: prepayment.id, notes: 'Возврат предоплаты', processedAt: refundAt, createdAt: refundAt, updatedAt: refundAt });
          }
        }
      }
      const chargesTotal = folioCharges.reduce((s, c) => s + Number(c.amount), 0);
      let paymentsTotal = folioPayments.reduce((s, p) => s + Number(p.amount), 0);
      if (status === 'checked_out' && chargesTotal - paymentsTotal > 0) {
        pay(local(departure, between(9, 12), between(0, 59)), chargesTotal - paymentsTotal, source === 'ota' ? 'vcc' : method(), 'Оплата при выезде');
        paymentsTotal = chargesTotal;
      }
      if (folioCharges.length || folioPayments.length) {
        rows.folios.push({ id: folioId, propertyId, reservationId: id, bookingId, guestId: guest.id, folioNumber: `F-${conf}`, type: 'guest',
          status: ['checked_out', 'cancelled', 'no_show'].includes(status) ? 'closed' : 'open', totalCharges: amount(chargesTotal), totalPayments: amount(paymentsTotal),
          balance: amount(chargesTotal - paymentsTotal), currencyCode: CURRENCY, createdAt, updatedAt: createdAt,
          closedAt: status === 'checked_out' ? local(departure, 12) : null, settledAt: status === 'checked_out' ? local(departure, 12) : null });
        rows.charges.push(...folioCharges); rows.payments.push(...folioPayments);
      }
    }
  }

  // Walk-in outlet sales (guests without a stay) on one house account, paid on the spot.
  const accountId = uid('de550001', 1);
  const walkCharges: any[] = [], walkPayments: any[] = [];
  for (let date = from; date <= today; date = addDays(date, 1)) {
    const weekend = [5, 6].includes(dayOfWeek(date));
    const checks = profile === 'borovoe' ? between(weekend ? 6 : 2, weekend ? 12 : 6) : between(weekend ? 10 : 6, weekend ? 18 : 12);
    for (let i = 0; i < checks; i++) {
      const spa = chance(0.15);
      const value = spa ? 12000 * between(1, 3) : round(between(6000, 32000), 500);
      const outlet = spa ? 'SPA' : chance(0.75) ? 'Ресторан SOVA' : 'Лобби-бар';
      walkCharges.push({ id: uid('de530001', ++chargeSeq), propertyId, houseAccountId: accountId, type: spa ? 'spa' : 'food_beverage', description: spa ? 'SPA визит' : 'Счёт ресторана',
        amount: amount(value), currencyCode: CURRENCY, outlet, taxAmount: '0', serviceDate: service(date), isLocked: date < today, postedAt: local(date, between(12, 22)) });
      addActual(date, spa ? 'spa' : 'food_beverage', value);
      const at = local(date, between(12, 22), between(0, 59));
      if (at < now) walkPayments.push({ id: uid('de540001', ++paymentSeq), propertyId, houseAccountId: accountId, method: pick(['other', 'other', 'credit_card', 'cash']),
        status: 'captured', amount: amount(value), currencyCode: CURRENCY, gatewayProvider: null, processedAt: at, createdAt: at, updatedAt: at });
    }
  }
  const walkTotal = walkCharges.reduce((s, c) => s + Number(c.amount), 0), walkPaid = walkPayments.reduce((s, p) => s + Number(p.amount), 0);

  // ---------------------------------------------------------------- write
  await db.transaction(async (tx: any) => {
    await chunked(rows.bookings, 500, (part) => tx.insert(schema.bookings).values(part));
    await chunked(rows.reservations, 400, (part) => tx.insert(schema.reservations).values(part));
    await chunked(rows.folios, 500, (part) => tx.insert(schema.folios).values(part));
    await chunked(rows.charges, 500, (part) => tx.insert(schema.charges).values(part));
    await chunked(rows.payments.filter((p) => !p.originalPaymentId), 500, (part) => tx.insert(schema.payments).values(part));
    await chunked(rows.payments.filter((p) => p.originalPaymentId), 500, (part) => tx.insert(schema.payments).values(part));
    await chunked(rows.allocations, 500, (part) => tx.insert(schema.reservationRevenueAllocations).values(part));
    await tx.insert(schema.houseAccounts).values({ id: accountId, propertyId, name: walkInName, kind: 'retail', status: 'open', currencyCode: CURRENCY,
      totalCharges: amount(walkTotal), totalPayments: amount(walkPaid), balance: amount(walkTotal - walkPaid) } as any);
    await chunked(walkCharges, 500, (part) => tx.insert(schema.charges).values(part));
    await chunked(walkPayments, 500, (part) => tx.insert(schema.payments).values(part));
    // Room status today: occupied where a guest is in house.
    const inHouse = rows.reservations.filter((r) => r.status === 'checked_in').map((r) => r.roomId).filter(Boolean);
    if (inHouse.length) await tx.update(schema.rooms).set({ status: 'occupied' } as any).where(and(eq(schema.rooms.propertyId, propertyId), inArray(schema.rooms.id, inHouse)));

    // Plan (daily, per revenue article) and confirmed expenses through yesterday, one version per month.
    const months: string[] = [];
    for (let m = from.slice(0, 7); m <= end.slice(0, 7); m = addDays(`${m}-28`, 7).slice(0, 7)) months.push(m);
    for (const month of months) {
      const start = `${month}-01`, last = addDays(addDays(`${month}-28`, 7).slice(0, 7) + '-01', -1);
      const budget: any[] = [], expenses: any[] = [];
      for (let date = start; date <= last; date = addDays(date, 1)) {
        const actual = dailyActual.get(date) ?? {};
        const revenue = Object.values(actual).reduce((s, v) => s + v, 0);
        for (const [article, value] of Object.entries(actual)) {
          const planArticle = article === 'package' ? 'food_beverage' : article;
          const existing = budget.find((e) => e.date === date && e.article === planArticle);
          const planned = round(value * (0.9 + rand() * 0.2));
          if (existing) existing.amount = amount(Number(existing.amount) + planned); else budget.push({ date, article: planArticle, amount: amount(planned) });
        }
        if (date < today) {
          const fixed = profile === 'borovoe' ? 180000 : 150000;
          expenses.push({ date, article: 'operations', amount: amount(round(fixed + revenue * 0.22)) },
            { date, article: 'selling', amount: amount(round(revenue * 0.07)) },
            { date, article: 'administration', amount: amount(round(fixed * 0.5)) },
            { date, article: 'other', amount: amount(round(revenue * 0.02 + 15000)) });
        }
      }
      if (budget.length) await tx.insert(schema.managementInputs).values({ propertyId, startDate: start, endDate: last, kind: 'budget', revision: 1, currencyCode: CURRENCY,
        entries: budget, reason: 'Демо-данные' } as any).onConflictDoNothing();
      if (expenses.length) await tx.insert(schema.managementInputs).values({ propertyId, startDate: start, endDate: last, kind: 'expenses', revision: 1, currencyCode: CURRENCY,
        entries: expenses, coverageThrough: expenses[expenses.length - 1].date, reason: 'Демо-данные' } as any).onConflictDoNothing();
    }
  });

  const manifestPath = args.get('manifest');
  if (manifestPath) writeFileSync(manifestPath, JSON.stringify({ propertyId, profile, today, stays: manifest }, null, 2));
  const count = (status: string) => rows.reservations.filter((r) => r.status === status).length;
  console.log(`Stays: ${rows.reservations.length} (checked out ${count('checked_out')}, in house ${count('checked_in')}, upcoming ${count('confirmed')}, cancelled ${count('cancelled')}, no-show ${count('no_show')})`);
  console.log(`Charges: ${rows.charges.length + walkCharges.length}, payments: ${rows.payments.length + walkPayments.length}, CRM-linked stays: ${manifest.length}`);
  await client.end();
}

function chunk<T>(list: T[], size = 2000): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

main().catch((error) => { console.error(error); process.exit(1); });

