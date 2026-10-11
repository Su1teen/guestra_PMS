import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Type,Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const MAINTENANCE_CATEGORIES = [
  'hvac', 'plumbing', 'electrical', 'furniture', 'appliance',
  'internet', 'lighting', 'bathroom', 'safety', 'other',
] as const;
export const MAINTENANCE_PRIORITIES = ['low', 'normal', 'high', 'critical'] as const;
export const MAINTENANCE_STATUSES = [
  'open', 'assigned', 'in_progress', 'waiting_parts', 'resolved', 'closed', 'cancelled',
] as const;

export class MaintenanceMutationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  idempotencyKey?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedRevision?: number;
}
export class MaintenanceRequestDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiProperty() @IsString() @MaxLength(200) idempotencyKey!: string;
}

export class CreateMaintenanceTicketDto extends MaintenanceMutationDto {
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

export class UpdateMaintenanceTicketDto extends MaintenanceMutationDto {
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
  @ApiPropertyOptional() @IsOptional() @Transform(({value})=>value==='true'?true:value==='false'?false:value) @IsBoolean() overdue?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) department?:string;
}
export class MaintenancePageDto extends ListMaintenanceTicketsDto {
  @ApiPropertyOptional() @IsOptional() @Type(()=>Number) @IsInt() @Min(1) page=1;
  @ApiPropertyOptional() @IsOptional() @Type(()=>Number) @IsInt() @Min(1) @Max(100) limit=50;
}

export class MaintenanceCommentDto extends MaintenanceMutationDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiProperty() @IsString() @MaxLength(10000) body!: string;
}

export class ReturnToServiceDto extends MaintenanceMutationDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiPropertyOptional({ description: 'Optional inspection/engineering note' })
  @IsOptional() @IsString() note?: string;
}
