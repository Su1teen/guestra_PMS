import { describe, expect, it, vi } from 'vitest';
import { workspaceTemplate } from '@telivityhaip/shared';
import { UsersService } from './users.service';
describe('workspace persistence', () => {
  const propertyId = 'a0000001-0000-4000-a000-000000000001';
  function harness(revision = 0) {
    let prefs: any = { reportFavorites: ['occupancy'], workspaces: { other: { revision: 3, layout: workspaceTemplate() }, [propertyId]: { revision, layout: workspaceTemplate() } } };
    const tx: any = { select: () => ({ from: () => ({ where: () => ({ for: async () => [{ preferences: prefs }] }) }) }), update: vi.fn(() => ({ set: (v: any) => ({ where: async () => { prefs = v.preferences; } }) })) };
    const db: any = { transaction: async (fn: any) => fn(tx) };
    return { service: new UsersService(db, {} as any), tx, prefs: () => prefs };
  }
  it('increments only the selected property revision and preserves report favorites', async () => {
    const h = harness(); const layout = workspaceTemplate('frontdesk');
    await expect(h.service.updateWorkspace('alice', { propertyId, expectedRevision: 0, layout: layout as any })).resolves.toMatchObject({ revision: 1, layout, persistent: true });
    expect(h.prefs().reportFavorites).toEqual(['occupancy']); expect(h.prefs().workspaces.other.revision).toBe(3);
  });
  it('refuses stale writers without touching the stored layout', async () => {
    const h = harness(2);
    await expect(h.service.updateWorkspace('alice', { propertyId, expectedRevision: 1, layout: workspaceTemplate() as any })).rejects.toMatchObject({ response: { code: 'WORKSPACE_CONFLICT' } });
    expect(h.tx.update).not.toHaveBeenCalled();
  });
  it('rejects unsafe layout fields before opening a transaction', async () => {
    const h = harness();
    await expect(h.service.updateWorkspace('alice', { propertyId, expectedRevision: 0, layout: { version: 2, query: 'SELECT' } })).rejects.toMatchObject({ response: { code: 'INVALID_WORKSPACE' } });
    expect(h.tx.update).not.toHaveBeenCalled();
  });
});
