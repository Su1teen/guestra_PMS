import { Controller, Get, Post, Patch, Body, Query, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import { RequirePermissions } from '../auth/permissions.decorator';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { ConnectInboxService } from './connect-inbox.service';

export const INBOX_CHANNELS = ['telegram', 'whatsapp', 'instagram', 'simulator', 'email', 'sms'] as const;

export class InboxListQueryDto {
  /** Also read by ParseUUIDPipe on the route; declared so whitelist validation accepts it. */
  @ApiPropertyOptional() @IsOptional() @IsUUID() propertyId?: string;
  @ApiPropertyOptional({ enum: ['focus', 'payment', 'follow_up', 'waiting_guest', 'all', 'archive'] })
  @IsOptional() @IsIn(['focus', 'payment', 'follow_up', 'waiting_guest', 'all', 'archive']) queue?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(30) channel?: string;
  @ApiPropertyOptional({ enum: ['ai', 'human', 'needs_human'] }) @IsOptional() @IsIn(['ai', 'human', 'needs_human']) mode?: string;
  @ApiPropertyOptional() @IsOptional() @IsIn(['true', 'false']) unread?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) search?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
export class InboxReplyDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(10000) text!: string;
  @ApiPropertyOptional({ description: 'Internal note, visible only to the team' }) @IsOptional() @IsBoolean() asNote?: boolean;
  @ApiPropertyOptional({ description: 'Email subject (email chats)' }) @IsOptional() @IsString() @MaxLength(300) subject?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(8) @MaxLength(100) idempotencyKey?: string;
}
export class InboxAutomationDto {
  @ApiProperty({ enum: ['ai', 'human'] }) @IsIn(['ai', 'human']) mode!: 'ai' | 'human';
}
export class InboxUpdateDto {
  @ApiPropertyOptional({ enum: ['open', 'pending', 'closed'] }) @IsOptional() @IsIn(['open', 'pending', 'closed']) status?: 'open' | 'pending' | 'closed';
  @ApiPropertyOptional() @IsOptional() @IsBoolean() read?: boolean;
}
export class InboxStartDto {
  @ApiProperty() @IsUUID() guestId!: string;
  @ApiProperty({ enum: INBOX_CHANNELS }) @IsIn(INBOX_CHANNELS as unknown as string[]) channel!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(10000) text!: string;
  @ApiPropertyOptional({ enum: ['ai', 'human'] }) @IsOptional() @IsIn(['ai', 'human']) automationMode?: 'ai' | 'human';
  @ApiPropertyOptional({ description: 'Open a separate chat (messengers continue the existing one)' }) @IsOptional() @IsBoolean() newChat?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) subject?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(8) @MaxLength(100) idempotencyKey?: string;
}

@ApiTags('Guest Inbox') @Controller('guest-inbox')
export class ConnectInboxController {
  constructor(private readonly inbox: ConnectInboxService) {}

  @Get('status') @RequirePermissions('communications.manage') @ApiOperation({ summary: 'Whether the guest inbox is available for this property' })
  status(@Query('propertyId', ParseUUIDPipe) p: string, @CurrentUser() u: AuthUser) { return this.inbox.status(p, u); }

  @Get() @RequirePermissions('communications.manage') @ApiOperation({ summary: 'Guest conversations on every channel with the CRM queues and filters' })
  list(@Query('propertyId', ParseUUIDPipe) p: string, @Query() q: InboxListQueryDto, @CurrentUser() u: AuthUser) { return this.inbox.list(p, u, q); }

  @Post('conversations') @RequirePermissions('communications.manage') @ApiOperation({ summary: 'Start a chat with a guest of this property' })
  start(@Query('propertyId', ParseUUIDPipe) p: string, @Body() dto: InboxStartDto, @CurrentUser() u: AuthUser) { return this.inbox.start(p, dto, u); }

  @Get(':id') @RequirePermissions('communications.manage') @ApiOperation({ summary: 'Conversation, notes and authorized PMS stay context' })
  detail(@Query('propertyId', ParseUUIDPipe) p: string, @Param('id') id: string, @CurrentUser() u: AuthUser) { return this.inbox.detail(p, id, u); }

  @Post(':id/messages') @RequirePermissions('communications.manage') @ApiOperation({ summary: 'Reply to the guest or add an internal note' })
  reply(@Query('propertyId', ParseUUIDPipe) p: string, @Param('id') id: string, @Body() dto: InboxReplyDto, @CurrentUser() u: AuthUser) {
    return this.inbox.reply(p, id, dto, u);
  }

  @Post(':id/automation') @RequirePermissions('communications.manage') @ApiOperation({ summary: 'Take the conversation over from AI, or hand it back' })
  automation(@Query('propertyId', ParseUUIDPipe) p: string, @Param('id') id: string, @Body() dto: InboxAutomationDto, @CurrentUser() u: AuthUser) {
    return this.inbox.automation(p, id, dto.mode, u);
  }

  @Post(':id/takeover') @RequirePermissions('communications.manage') @ApiOperation({ summary: 'Persist human ownership in CRM with an authenticated PMS staff reference' })
  takeover(@Query('propertyId', ParseUUIDPipe) p: string, @Param('id') id: string, @CurrentUser() u: AuthUser) { return this.inbox.takeover(p, id, u); }

  @Patch(':id') @RequirePermissions('communications.manage') @ApiOperation({ summary: 'Close / reopen the conversation or mark it read' })
  update(@Query('propertyId', ParseUUIDPipe) p: string, @Param('id') id: string, @Body() dto: InboxUpdateDto, @CurrentUser() u: AuthUser) {
    return this.inbox.update(p, id, dto, u);
  }
}
