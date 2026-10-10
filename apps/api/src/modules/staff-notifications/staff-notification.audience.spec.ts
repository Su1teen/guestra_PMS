import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { StaffNotificationService } from './staff-notification.service';
describe('hotel notification audience and replay', () => {
  it('does not broadcast or emit a replayed notification', async () => {
    const db: any = { insert: () => ({ values: () => ({ onConflictDoNothing: () => ({ returning: async () => [] }) }) }) };
    const events: any = { broadcastStaffNotification: vi.fn() }; const webhook: any = { emit: vi.fn() };
    expect(await new StaffNotificationService(db,webhook,events).create({ propertyId: 'hotel-a', title: 'Бронь', message: 'Событие', type: 'hotel_event', deduplicationKey: 'stable' })).toBeNull();
    expect(webhook.emit).not.toHaveBeenCalled(); expect(events.broadcastStaffNotification).not.toHaveBeenCalled();
  });
  it('restricts the list to its property, user audience and permissions', async () => {
    let condition: any;
    const chain: any = { from: () => chain, leftJoin: () => chain, where: (c: any) => { condition=c;return chain; }, orderBy: () => chain, limit: async () => [] };
    const service=new StaffNotificationService({select:()=>chain} as any,{} as any,{} as any);
    await service.listForUser('hotel-a','alice',['rooms.read']);
    const query=new PgDialect().sqlToQuery(condition);
    expect(query.params).toEqual(expect.arrayContaining(['hotel-a','alice','rooms.read']));
    expect(query.sql).toContain('"required_permission"'); expect(query.sql).toContain('"user_id"');
    await service.listForUser('hotel-a','alice',[]);
    expect(new PgDialect().sqlToQuery(condition).sql).toContain('"required_permission" is null');
  });
  it('refuses guessed ids outside the permitted audience before inserting a read receipt', async () => {
    const insert=vi.fn(); const chain:any={from:()=>chain,where:async()=>[]};
    const service=new StaffNotificationService({select:()=>chain,insert} as any,{} as any,{} as any);
    await expect(service.markRead('foreign','hotel-a','alice',['rooms.read'])).rejects.toThrow('not found');
    expect(insert).not.toHaveBeenCalled();
  });
});
