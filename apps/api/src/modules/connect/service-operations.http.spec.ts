import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import request from 'supertest';
import { ServiceOperationsController } from './service-operations.controller';
import { ConnectServiceBookingService } from './connect-service-booking.service';
import { PermissionsGuard } from '../auth/permissions.guard';
import { ConnectScopeGuard } from '../auth/connect-scope.guard';
import { ConnectController } from './connect.controller';
const P = '10000000-0000-4000-a000-000000000001'; const OTHER = '10000000-0000-4000-a000-000000000002'; const ID = '10000000-0000-4000-a000-000000000003';
describe('service operations HTTP permissions and validation', () => {
  let app: INestApplication; let granted: string[];
  const service = { book: vi.fn().mockResolvedValue({ id: ID }), transition: vi.fn(), get: vi.fn().mockResolvedValue({ id: ID }), closeRequest: vi.fn().mockResolvedValue({ status: 'closed' }), updateResource: vi.fn().mockResolvedValue({ id: ID }) };
  beforeEach(async () => {
    granted = ['services.read','reservations.write']; vi.clearAllMocks();
    const module = await Test.createTestingModule({ controllers: [ServiceOperationsController], providers: [{ provide: ConnectServiceBookingService, useValue: service }] }).compile();
    app = module.createNestApplication(); app.use((req: any, _res: any, next: () => void) => { req.user = { sub: 'test', email: 'test@example.invalid' }; next(); });
    app.useGlobalGuards(new PermissionsGuard(new Reflector(), { get: () => 'true' } as any, { findLocalUser: async () => ({ id: 'test' }), getEffectivePermissions: async (_id: string, propertyId: string) => propertyId === P ? granted : [] } as any));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })); await app.init();
  });
  afterEach(async () => app.close());
  const body = () => ({ propertyId: P, serviceId: ID, startAt: '2027-01-01T09:00:00Z', endAt: '2027-01-01T10:00:00Z', guestId: ID, resourceId: ID, idempotencyKey: 'key' });
  it('requires both read and write permission for a staff booking', async () => {
    granted = ['services.read']; await request(app.getHttpServer()).post('/services/bookings').send(body()).expect(403); expect(service.book).not.toHaveBeenCalled();
  });
  it('denies a property outside the effective grants', async () => {
    await request(app.getHttpServer()).post('/services/bookings').send({ ...body(), propertyId: OTHER }).expect(403); expect(service.book).not.toHaveBeenCalled();
  });
  it('accepts the staff resource and invokes the single existing scheduling service', async () => {
    await request(app.getHttpServer()).post('/services/bookings').send(body()).expect(201); expect(service.book).toHaveBeenCalledWith(expect.objectContaining({ propertyId: P, resourceId: ID }), 'front_desk', ID);
  });
  it('rejects internal pricing and invalid nested integration context', async () => {
    for (const extra of [{ pricingSnapshot: { total: 0 } }, { integrationContext: { sourceSystem: 'test', customerId: 12 } }, { idempotencyKey: '' }]) await request(app.getHttpServer()).post('/services/bookings').send({ ...body(), ...extra }).expect(400);
    expect(service.book).not.toHaveBeenCalled();
  });
  it('does not silently ignore a move in a cancellation request', async () => {
    await request(app.getHttpServer()).post(`/services/bookings/${ID}/cancel`).send({ propertyId: P, expectedRevision: 1, idempotencyKey: 'cancel', startAt: body().startAt }).expect(400); expect(service.transition).not.toHaveBeenCalled();
  });
  it('requires a valid explicit property on detail routes', async () => {
    await request(app.getHttpServer()).get(`/services/bookings/${ID}`).expect(403);
    expect(service.get).not.toHaveBeenCalled();
  });
  it('protects recovery closure and resource edits with their own property permissions', async () => {
    granted = ['services.read'];
    await request(app.getHttpServer()).post('/services/booking-request/close').send({ propertyId: P, idempotencyKey: 'original' }).expect(403);
    expect(service.closeRequest).not.toHaveBeenCalled();
    granted = ['services.manage'];
    const edit = { propertyId: P, serviceId: ID, code: 'room', name: 'Кабинет', capacity: 1, idempotencyKey: 'edit', expectedUpdatedAt: '2026-01-01T00:00:00Z' };
    await request(app.getHttpServer()).patch(`/services/resources/${ID}`).send({ ...edit, propertyId: OTHER }).expect(403);
    await request(app.getHttpServer()).patch(`/services/resources/${ID}`).send(edit).expect(200);
    expect(service.updateResource).toHaveBeenCalledWith(ID, expect.objectContaining(edit));
  });
});
describe('service Connect capabilities', () => {
  const guard = new ConnectScopeGuard({ get: () => 'true' } as ConfigService, {});
  const context = (handler: any, scopes: string[], propertyId = P) => ({ getHandler: () => handler, switchToHttp: () => ({ getRequest: () => ({ connect: { scope: 'property', propertyId: P, scopes }, body: { propertyId } }) }) }) as any;
  it('permits service reads and rejects writes for an explicit read-only credential', async () => {
    await expect(guard.canActivate(context(ConnectController.prototype.serviceOptions, ['services.read']))).resolves.toBe(true);
    await expect(guard.canActivate(context(ConnectController.prototype.bookService, ['services.read']))).rejects.toThrow();
    await expect(guard.canActivate(context(ConnectController.prototype.cancelServiceBooking, ['services.read']))).rejects.toThrow();
  });
  it('still denies a foreign property with write permission', async () => {
    await expect(guard.canActivate(context(ConnectController.prototype.bookService, ['services.write'], OTHER))).rejects.toThrow();
  });
  it('retains explicitly documented compatibility for historical keys without scopes', async () => {
    await expect(guard.canActivate(context(ConnectController.prototype.bookService, []))).resolves.toBe(true);
    await expect(guard.canActivate(context(ConnectController.prototype.bookService, ['legacy-label']))).resolves.toBe(true);
    await expect(guard.canActivate(context(ConnectController.prototype.bookService, ['pms:scoped:v1']))).rejects.toThrow();
  });
});
