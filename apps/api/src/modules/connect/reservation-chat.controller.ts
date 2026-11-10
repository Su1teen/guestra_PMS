import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import { RequirePermissions } from '../auth/permissions.decorator';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { ReservationChatService } from './reservation-chat.service';
import { INBOX_CHANNELS } from './connect-inbox.controller';

export class ChatDocumentDto {
  @ApiProperty({ enum: ['ai', 'manual'], description: 'ai: into the guest AI conversation; manual: a new staff chat' }) @IsIn(['ai', 'manual']) mode!: 'ai' | 'manual';
  @ApiPropertyOptional({ enum: ['proposal', 'confirmation'] }) @IsOptional() @IsIn(['proposal', 'confirmation']) kind?: 'proposal' | 'confirmation';
  @ApiPropertyOptional({ enum: INBOX_CHANNELS }) @IsOptional() @IsIn(INBOX_CHANNELS as unknown as string[]) channel?: string;
  @ApiPropertyOptional({ description: 'Edited message; must keep the document link' }) @IsOptional() @IsString() @MinLength(1) @MaxLength(10000) text?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(8) @MaxLength(100) idempotencyKey?: string;
}
export class ResolveChatDocumentDto {
  @ApiProperty({ enum: ['confirmed', 'declined'] }) @IsIn(['confirmed', 'declined']) outcome!: 'confirmed' | 'declined';
}
const hostOf = (req: Request) => String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0]!.trim();

/** Booking documents sent into guest chats and the guest's confirmation of the details. */
@ApiTags('Reservations') @Controller('reservations')
export class ReservationChatController {
  constructor(private readonly chat: ReservationChatService) {}

  @Get(':id/confirmation/chat') @RequirePermissions('reservations.read', 'communications.manage')
  @ApiOperation({ summary: 'Documents sent to chats for this booking and whether the guest confirmed the details' })
  status(@Param('id', ParseUUIDPipe) id: string, @Query('propertyId', ParseUUIDPipe) propertyId: string, @CurrentUser() user: AuthUser) {
    return this.chat.status(id, propertyId, user);
  }

  @Get(':id/confirmation/chat/preview') @RequirePermissions('reservations.read', 'communications.manage')
  @ApiOperation({ summary: 'Prepared chat message with the signed document link' })
  preview(@Param('id', ParseUUIDPipe) id: string, @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Query('kind') kind: string | undefined, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.chat.preview(id, propertyId, kind === 'proposal' || kind === 'confirmation' ? kind : undefined, user, hostOf(req));
  }

  @Post(':id/confirmation/chat') @RequirePermissions('reservations.write', 'communications.manage')
  @ApiOperation({ summary: 'Send the document into a guest chat and wait for the guest to confirm (AI chat or a new staff chat)' })
  send(@Param('id', ParseUUIDPipe) id: string, @Query('propertyId', ParseUUIDPipe) propertyId: string, @Body() dto: ChatDocumentDto,
    @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.chat.send(id, propertyId, dto, user, hostOf(req));
  }

  @Post(':id/confirmation/chat/:confirmationId/resolve') @RequirePermissions('reservations.write', 'communications.manage')
  @ApiOperation({ summary: 'Record the guest answer by hand (e.g. confirmed by phone)' })
  resolve(@Param('id', ParseUUIDPipe) id: string, @Param('confirmationId') confirmationId: string, @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Body() dto: ResolveChatDocumentDto, @CurrentUser() user: AuthUser) {
    return this.chat.resolve(id, propertyId, confirmationId, dto.outcome, user);
  }
}
