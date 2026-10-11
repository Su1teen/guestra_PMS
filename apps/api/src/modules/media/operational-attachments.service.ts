import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageService } from './storage/storage.service';
import { privatePhoto, privatePhotoIdentity } from './private-photo';
import { HousekeepingService } from '../housekeeping/housekeeping.service';
import { MaintenanceService } from '../maintenance/maintenance.service';
import { PermissionsService } from '../auth/permissions.service';
import type { AuthUser } from '../auth/current-user.decorator';
import type { AuditActor } from '../../common/audit/audit-actor';

export type AttachmentOwner = 'housekeeping' | 'maintenance';
@Injectable()
export class OperationalAttachmentsService {
  constructor(
    private readonly storage: StorageService,
    private readonly housekeeping: HousekeepingService,
    private readonly maintenance: MaintenanceService,
    private readonly permissions: PermissionsService,
    private readonly config: ConfigService,
  ) {}
  private async scope(
    propertyId: string,
    kind: string,
    id: string,
    user: AuthUser | undefined,
    write: boolean,
  ) {
    if (!['housekeeping', 'maintenance'].includes(kind))
      throw new BadRequestException('Неизвестный тип задачи.');
    let localId: string | undefined, workerId: string | undefined;
    if (this.config.get('AUTH_ENABLED', 'true') !== 'false') {
      const local =
        user && (await this.permissions.findLocalUser(user.sub, user.email));
      if (!local || local.status !== 'active')
        throw new ForbiddenException('Нет активной учётной записи.');
      localId = local.id;
      const keys = await this.permissions.getEffectivePermissions(
        local.id,
        propertyId,
      );
      if (
        kind === 'maintenance' &&
        !keys.includes(write ? 'maintenance.update' : 'maintenance.view')
      )
        throw new ForbiddenException('Нет права доступа к технической заявке.');
      if (kind === 'housekeeping') {
        if (!keys.includes('housekeeping.read'))
          throw new ForbiddenException('Нет права доступа к уборке.');
        if (
          write &&
          !keys.includes('housekeeping.manage') &&
          !keys.includes('housekeeping.execute')
        )
          throw new ForbiddenException('Нет права выполнения задач.');
        if (!keys.includes('housekeeping.manage')) workerId = local.id;
      }
    }
    const entity =
      kind === 'maintenance'
        ? (await this.maintenance.findById(id, propertyId)).ticket
        : await this.housekeeping.findById(id, propertyId);
    if (workerId && entity.assignedTo !== workerId)
      throw new ForbiddenException('Задача назначена другому сотруднику.');
    return { entity, localId, workerId };
  }
  async capabilities(
    propertyId: string,
    kind: string,
    id: string,
    user?: AuthUser,
  ) {
    const { entity } = await this.scope(propertyId, kind, id, user, false);
    let canUpload = true;
    try {
      await this.scope(propertyId, kind, id, user, true);
    } catch (error) {
      if (!(error instanceof ForbiddenException)) throw error;
      canUpload = false;
    }
    // Legacy public links are not automatically trusted or fetched by the private workflow.
    const attachments = (entity.attachments ?? [])
      .filter(
        (a: any) =>
          a.id &&
          a.storageKey?.startsWith(
            `properties/${propertyId}/private/${kind}/${id}/`,
          ),
      )
      .map(({ id, name, contentType, size }: any) => ({
        id,
        name,
        contentType,
        size,
      }));
    return {
      configured: this.storage.privateConfigured,
      canUpload,
      attachments,
      maxBytes: 10 * 1024 * 1024,
      contentTypes: ['image/jpeg', 'image/png', 'image/webp'],
    };
  }
  async upload(
    propertyId: string,
    kind: string,
    id: string,
    file:
      | { buffer: Buffer; mimetype: string; originalname: string }
      | undefined,
    key: string,
    user?: AuthUser,
    actor?: AuditActor,
  ) {
    const scope = await this.scope(propertyId, kind, id, user, true);
    if (!file) throw new BadRequestException('Выберите фотографию.');
    const attachment = privatePhoto(
      file.buffer,
      file.mimetype,
      file.originalname,
      propertyId,
      id,
      key,
      kind,
    );
    await this.storage.putPrivate(
      file.buffer,
      attachment.storageKey,
      attachment.contentType,
    );
    // Never delete on a DB failure: another same-key writer may have committed the immutable object.
    // Unreferenced objects stay private and require an explicit maintenance cleanup policy.
    const localActor = { ...actor, userId: scope.localId ?? null };
    if (kind === 'maintenance')
      await this.maintenance.addAttachment(
        id,
        propertyId,
        attachment,
        localActor,
        { idempotencyKey: key },
      );
    else
      await this.housekeeping.addAttachment(
        id,
        propertyId,
        attachment,
        localActor,
        scope.workerId,
      );
    return attachment;
  }
  async requestStatus(
    propertyId: string,
    kind: string,
    id: string,
    key: string,
    user?: AuthUser,
  ) {
    const { entity } = await this.scope(propertyId, kind, id, user, false);
    const identity = privatePhotoIdentity(propertyId, id, key, kind);
    const accepted = (entity.attachments ?? []).find(
      (a: any) => a.id === identity.id && a.storageKey === identity.storageKey,
    );
    return accepted
      ? { state: 'committed', attachmentId: accepted.id }
      : { state: 'unconfirmed' };
  }
  async read(
    propertyId: string,
    kind: string,
    id: string,
    attachmentId: string,
    user?: AuthUser,
  ) {
    const { entity } = await this.scope(propertyId, kind, id, user, false);
    const attachment = (entity.attachments ?? []).find(
      (a: any) => a.id === attachmentId,
    );
    if (
      !attachment ||
      !attachment.storageKey?.startsWith(
        `properties/${propertyId}/private/${kind}/${id}/`,
      )
    )
      throw new NotFoundException('Фотография не найдена в этой задаче.');
    let buffer: Buffer;
    try {
      buffer = await this.storage.readPrivate(attachment.storageKey);
    } catch (error) {
      if ((error as any)?.code === 'ENOENT')
        throw new NotFoundException(
          'Фотография временно недоступна в хранилище. Обратитесь к администратору.',
        );
      throw error;
    }
    return { buffer, attachment };
  }
}
