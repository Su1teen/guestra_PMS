import {
  Injectable,
  OnModuleInit,
  Logger,
  NotImplementedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageDriver, PutOptions, PutResult } from './storage.driver';
import { LocalDriver } from './local.driver';
import { resolve, relative, sep } from 'node:path';

/**
 * Selects and delegates to a storage driver based on env configuration.
 *
 * STORAGE_DRIVER=s3 (with S3_* vars) → S3Driver (lazily imported so the AWS SDK
 * never loads in the default demo). Anything else → LocalDriver (uploads
 * disabled; URL-paste only).
 */
@Injectable()
export class StorageService implements OnModuleInit, StorageDriver {
  private readonly logger = new Logger(StorageService.name);
  private driver: StorageDriver = new LocalDriver();
  private privateDriver: StorageDriver = new LocalDriver();

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const privateRoot = this.config.get<string>('PRIVATE_STORAGE_DIR');
    if (privateRoot) {
      const root = resolve(privateRoot);
      const publicRoots = ['dashboard', 'booking'].map((app) =>
        resolve(__dirname, '../../../../../', app, 'dist'),
      );
      if (
        publicRoots.some((publicRoot) => {
          const path = relative(publicRoot, root);
          return (
            path === '' ||
            (!path.startsWith('..' + sep) &&
              path !== '..' &&
              !path.includes(':'))
          );
        })
      )
        throw new Error(
          'PRIVATE_STORAGE_DIR должен находиться вне публичных каталогов приложения.',
        );
    }
    this.privateDriver = new LocalDriver(privateRoot);
    if (this.config.get<string>('STORAGE_DRIVER') !== 's3') {
      return;
    }
    const bucket = this.config.get<string>('S3_BUCKET');
    const accessKeyId = this.config.get<string>('S3_ACCESS_KEY_ID');
    const secretAccessKey = this.config.get<string>('S3_SECRET_ACCESS_KEY');
    if (!bucket || !accessKeyId || !secretAccessKey) {
      this.logger.warn(
        'STORAGE_DRIVER=s3 but S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are missing — uploads disabled.',
      );
      return;
    }
    // Lazy import keeps @aws-sdk/client-s3 out of the default demo runtime.
    const { S3Driver } = await import('./s3.driver');
    this.driver = new S3Driver({
      bucket,
      region: this.config.get<string>('S3_REGION', 'us-east-1'),
      endpoint: this.config.get<string>('S3_ENDPOINT') || undefined,
      accessKeyId,
      secretAccessKey,
      forcePathStyle:
        this.config.get<string>('S3_FORCE_PATH_STYLE', 'true') !== 'false',
      publicBaseUrl: this.config.get<string>('S3_PUBLIC_BASE_URL') || undefined,
    });
    this.logger.log(`Object storage enabled (bucket: ${bucket}).`);
  }

  get configured(): boolean {
    return this.driver.configured;
  }

  put(buffer: Buffer, opts: PutOptions): Promise<PutResult> {
    return this.driver.put(buffer, opts);
  }

  delete(storageKey: string): Promise<void> {
    return this.driver.delete(storageKey);
  }
  get privateConfigured(): boolean {
    return this.privateDriver.privateConfigured === true;
  }
  async putPrivate(
    buffer: Buffer,
    storageKey: string,
    contentType: string,
  ): Promise<void> {
    if (!this.privateConfigured || !this.privateDriver.putPrivate)
      throw new NotImplementedException(
        'Приватное хранилище фотографий не настроено.',
      );
    await this.privateDriver.putPrivate(buffer, storageKey, contentType);
  }
  async readPrivate(storageKey: string): Promise<Buffer> {
    if (!this.privateConfigured || !this.privateDriver.readPrivate)
      throw new NotImplementedException(
        'Приватное хранилище фотографий не настроено.',
      );
    return this.privateDriver.readPrivate(storageKey);
  }
}
