import { describe, it, expect, vi } from 'vitest';
import 'reflect-metadata';
import { ReportsController } from './reports.controller';
import { PERMISSIONS_KEY } from '../auth/permissions.decorator';

describe('ReportsController authorization', () => {
  it('requires the reports.view permission on the controller', () => {
    // Financial/occupancy reports must not be readable by any authenticated user
    // (e.g. housekeeping) — PermissionsGuard enforces this metadata.
    const perms = Reflect.getMetadata(PERMISSIONS_KEY, ReportsController);
    expect(perms).toContain('reports.view');
  });

  it('allows Revenue report readers without exposing management-only reporting', () => {
    const revenuePermission = Reflect.getMetadata(PERMISSIONS_KEY, ReportsController.prototype.getRevenueOverview)
      ?? Reflect.getMetadata(PERMISSIONS_KEY, ReportsController);
    expect(revenuePermission).toEqual(['reports.view']);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, ReportsController.prototype.getManagementSummary))
      .toEqual(['management_dashboard.view']);
  });

  it('passes the caller property and optional operational date to shared Revenue reporting', async () => {
    const reports = { getRevenueOverview: vi.fn().mockResolvedValue({ date: '2027-05-01' }) };
    const controller = new ReportsController(reports as any, {} as any, {} as any);
    const query = { propertyId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', date: '2027-05-01' };
    expect(await controller.getRevenueOverview(query)).toEqual({ date: query.date });
    expect(reports.getRevenueOverview).toHaveBeenCalledWith(query.propertyId, query.date);
  });
});
