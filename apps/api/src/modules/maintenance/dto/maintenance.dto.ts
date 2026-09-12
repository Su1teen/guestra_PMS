import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const MAINTENANCE_CATEGORIES = [
  'hvac', 'plumbing', 'electrical', 'furniture', 'appliance',
  'internet', 'lighting', 'bathroom', 'safety', 'other',
] as const;
export const MAINTENANCE_PRIORITIES = ['low', 'normal', 'high', 'critical'] as const;
export const MAINTENANCE_STATUSES = [
  'open', 'assigned', 'in_progress', 'waiting_parts', 'resolved', 'closed', 'cancelled',
] as const;

export class CreateMaintenanceTicketDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() roomId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() reservationId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() guestId?: string;
  @ApiProperty({ enum: MAINTENANCE_CATEGORIES }) @IsEnum(MAINTENANCE_CATEGORIES) category!: string;
  @ApiProperty() @IsString() @MaxLength(255) title!: string;
  @ApiProperty() @IsString() description!: string;
  @ApiPropertyOptional({ enum: MAINTENANCE_PRIORITIES, default: 'normal' })
  @IsOptional() @IsEnum(MAINTENANCE_PRIORITIES) priority?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() department?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() assigneeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() slaDeadline?: string;
  @ApiPropertyOptional({ default: false }) @IsOptional() @IsBoolean() blocksInventory?: boolean;
}

export class UpdateMaintenanceTicketDto {
  @ApiPropertyOptional({ enum: MAINTENANCE_CATEGORIES })
  @IsOptional() @IsEnum(MAINTENANCE_CATEGORIES) category?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(255) title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional({ enum: MAINTENANCE_PRIORITIES })
  @IsOptional() @IsEnum(MAINTENANCE_PRIORITIES) priority?: string;
  @ApiPropertyOptional({ enum: MAINTENANCE_STATUSES })
  @IsOptional() @IsEnum(MAINTENANCE_STATUSES) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() department?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() assigneeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() slaDeadline?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() resolution?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() blocksInventory?: boolean;
}

export class ListMaintenanceTicketsDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() roomId?: string;
  @ApiPropertyOptional({ enum: MAINTENANCE_CATEGORIES })
  @IsOptional() @IsEnum(MAINTENANCE_CATEGORIES) category?: string;
  @ApiPropertyOptional({ enum: MAINTENANCE_PRIORITIES })
  @IsOptional() @IsEnum(MAINTENANCE_PRIORITIES) priority?: string;
  @ApiPropertyOptional({ enum: MAINTENANCE_STATUSES })
  @IsOptional() @IsEnum(MAINTENANCE_STATUSES) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() assigneeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() overdue?: boolean;
}

export class MaintenanceCommentDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiProperty() @IsString() body!: string;
}

export class MaintenanceAttachmentDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiProperty() @IsString() url!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() contentType?: string;
}

export class ReturnToServiceDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiPropertyOptional({ description: 'Optional inspection/engineering note' })
  @IsOptional() @IsString() note?: string;
}
