import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OperationalAttachmentsService } from './operational-attachments.service';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { AuditActorCtx, type AuditActor } from '../../common/audit/audit-actor';
import { PRIVATE_PHOTO_MAX_BYTES } from './private-photo';

@ApiTags('operational-attachments')
@Controller('operational-attachments')
export class OperationalAttachmentsController {
  constructor(private readonly service: OperationalAttachmentsService) {}
  // The dynamic owner type is authorized explicitly by the service; global JWT authentication remains active.
  @Get(':kind/:id/capabilities')
  @ApiOperation({ summary: 'Authorized private photo storage capability' })
  capabilities(
    @Param('kind') kind: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.service.capabilities(propertyId, kind, id, user);
  }
  @Post(':kind/:id')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a property and owner scoped private photo' })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: PRIVATE_PHOTO_MAX_BYTES, files: 1, fields: 1 },
    }),
  )
  upload(
    @Param('kind') kind: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Body('idempotencyKey') key: string,
    @UploadedFile() file: any,
    @CurrentUser() user?: AuthUser,
    @AuditActorCtx() actor?: AuditActor,
  ) {
    return this.service.upload(propertyId, kind, id, file, key, user, actor);
  }
  @Get(':kind/:id/request')
  requestStatus(
    @Param('kind') kind: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Query('idempotencyKey') key: string,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.service.requestStatus(propertyId, kind, id, key, user);
  }
  @Get(':kind/:id/:attachmentId')
  @ApiOperation({
    summary:
      'Read a private photo after current property, owner and permission checks',
  })
  async read(
    @Param('kind') kind: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) response: any,
  ) {
    const { buffer, attachment } = await this.service.read(
      propertyId,
      kind,
      id,
      attachmentId,
      user,
    );
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(buffer, {
      type: attachment.contentType,
      disposition: `inline; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
    });
  }
}
