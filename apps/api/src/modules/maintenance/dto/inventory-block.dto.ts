import {
  IsUUID,
  IsString,
  IsIn,
  IsISO8601,
  IsOptional,
  IsInt,
  Min,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class InventoryBlockDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiProperty() @IsUUID() roomId!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() maintenanceTicketId?: string;
  @ApiProperty() @IsISO8601({ strict: true }) startDate!: string;
  @ApiProperty() @IsISO8601({ strict: true }) endDate!: string;
  @ApiProperty({ enum: ['OOO', 'OOS'] }) @IsIn(['OOO', 'OOS']) kind!:
    | 'OOO'
    | 'OOS';
  @ApiProperty() @IsString() @MaxLength(2000) reason!: string;
  @ApiProperty() @IsString() @MaxLength(200) idempotencyKey!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedRevision?: number;
}
export class InventoryReturnDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiProperty() @IsString() @MaxLength(2000) reason!: string;
  @ApiProperty() @IsString() @MaxLength(200) idempotencyKey!: string;
  @ApiProperty() @IsInt() @Min(1) expectedRevision!: number;
}
