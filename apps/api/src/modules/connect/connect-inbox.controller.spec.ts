import { describe, expect, it } from 'vitest';
import { ValidationPipe } from '@nestjs/common';
import { InboxListQueryDto, InboxStartDto } from './connect-inbox.controller';

// Same options as the global pipe in main.ts: a query DTO must declare every parameter the route receives.
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const query = (value: Record<string, unknown>) => pipe.transform(value, { type: 'query', metatype: InboxListQueryDto });

describe('guest inbox request validation', () => {
  it('accepts the propertyId together with the filters', async () => {
    await expect(query({ propertyId: '10000000-0000-4000-8000-000000000001', queue: 'focus', channel: 'email', limit: '20' }))
      .resolves.toMatchObject({ queue: 'focus', channel: 'email', limit: 20 });
  });
  it('rejects unknown queues and parameters', async () => {
    await expect(query({ queue: 'everything' })).rejects.toThrow();
    await expect(query({ hack: '1' })).rejects.toThrow();
  });
  it('only lets staff start chats on supported channels', async () => {
    await expect(pipe.transform({ guestId: '20000000-0000-4000-8000-000000000002', channel: 'fax', text: 'x' }, { type: 'body', metatype: InboxStartDto })).rejects.toThrow();
  });
});
