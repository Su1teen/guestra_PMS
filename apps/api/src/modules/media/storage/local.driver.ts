import {
  BadRequestException,
  ConflictException,
  NotImplementedException,
} from '@nestjs/common';
import { StorageDriver, PutResult } from './storage.driver';
import { mkdir, writeFile, readFile, link, unlink } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Default driver used when object storage is not configured.
 *
 * Uploads are rejected with a clear, actionable message; the dashboard hides
 * the "Upload file" control and uses URL-paste instead. This keeps the
 * one-command demo free of any object-storage dependency.
 */
export class LocalDriver implements StorageDriver {
  readonly configured = false;
  constructor(private readonly privateRoot?: string) {}
  get privateConfigured() {
    return Boolean(this.privateRoot);
  }
  private path(key: string) {
    if (!this.privateRoot)
      throw new NotImplementedException(
        'Приватное хранилище не настроено. Укажите PRIVATE_STORAGE_DIR на постоянном закрытом томе.',
      );
    if (
      !/^properties\/[0-9a-f-]{36}\/private\/(housekeeping|maintenance)\/[0-9a-f-]{36}\/[0-9a-f]{64}$/.test(
        key,
      )
    )
      throw new BadRequestException('Некорректный ключ приватного файла.');
    const base = resolve(this.privateRoot),
      path = resolve(base, key);
    if (!path.startsWith(base + sep))
      throw new BadRequestException('Некорректный путь файла.');
    return path;
  }
  async putPrivate(buffer: Buffer, key: string): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = path + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, buffer, { flag: 'wx', mode: 0o600 });
    try {
      try {
        await link(temporary, path);
      } catch (e: any) {
        if (e.code !== 'EEXIST') throw e;
        if (!(await readFile(path)).equals(buffer))
          throw new ConflictException(
            'Ключ загрузки уже использован для другого файла.',
          );
      }
    } finally {
      await unlink(temporary);
    }
  }
  async readPrivate(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }

  async put(): Promise<PutResult> {
    throw new NotImplementedException(
      'Object storage is not configured. Paste an image URL instead, or set STORAGE_DRIVER=s3 with the S3_* environment variables.',
    );
  }

  async delete(): Promise<void> {
    // No-op: nothing is ever stored by this driver.
  }
}
