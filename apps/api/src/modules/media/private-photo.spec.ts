import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privatePhoto, PRIVATE_PHOTO_MAX_BYTES } from './private-photo';
import { LocalDriver } from './storage/local.driver';
const P = '10000000-0000-4000-a000-000000000001',
  ID = '10000000-0000-4000-a000-000000000002';
const png = () => {
  const bytes = Buffer.alloc(32);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.write('IHDR', 12);
  return bytes;
};
describe('Private operational photo boundaries', () => {
  const directories: string[] = [];
  afterAll(async () => {
    for (const path of directories)
      await rm(path, { recursive: true, force: true });
  });
  it('requires the actual allowed signature, matching MIME, bounded bytes and a retry key', () => {
    expect(() =>
      privatePhoto(Buffer.from('<svg/>'), 'image/svg+xml', 'x', P, ID, 'key'),
    ).toThrow();
    expect(() =>
      privatePhoto(png(), 'image/jpeg', 'x', P, ID, 'key'),
    ).toThrow();
    expect(() =>
      privatePhoto(
        Buffer.alloc(PRIVATE_PHOTO_MAX_BYTES + 1),
        'image/png',
        'x',
        P,
        ID,
        'key',
      ),
    ).toThrow();
    expect(() => privatePhoto(png(), 'image/png', 'x', P, ID, '')).toThrow();
  });
  it('uses a stable scoped opaque identity without an anonymous URL', () => {
    const a = privatePhoto(png(), 'image/png', 'Фото\r\n.png', P, ID, 'same');
    expect(a).toEqual(
      privatePhoto(png(), 'image/png', 'Фото\r\n.png', P, ID, 'same'),
    );
    expect(a).not.toHaveProperty('url');
    expect(a.name).not.toMatch(/[\r\n]/);
    expect(
      privatePhoto(png(), 'image/png', 'x', P, ID, 'same', 'housekeeping').id,
    ).not.toBe(a.id);
  });
  it('atomically retains one immutable file during concurrent same-key uploads and rejects replacement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'guestra-private-'));
    directories.push(directory);
    const driver = new LocalDriver(directory);
    const photo = privatePhoto(png(), 'image/png', 'x', P, ID, 'key');
    await Promise.all([
      driver.putPrivate(png(), photo.storageKey),
      driver.putPrivate(png(), photo.storageKey),
    ]);
    expect(await driver.readPrivate(photo.storageKey)).toEqual(png());
    const changed = png();
    changed[31] = 1;
    await expect(
      driver.putPrivate(changed, photo.storageKey),
    ).rejects.toMatchObject({ status: 409 });
    expect(await driver.readPrivate(photo.storageKey)).toEqual(png());
    await expect(driver.readPrivate('../../public/x')).rejects.toMatchObject({
      status: 400,
    });
  });
});
