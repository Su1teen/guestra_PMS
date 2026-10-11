import {
  IsUUID,
  IsISO8601,
  IsString,
  IsOptional,
  IsIn,
  IsArray,
  ValidateNested,
  IsInt,
  Min,
  Max,
  MaxLength,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
class ShiftBreakDto {
  @ApiProperty() @IsISO8601({ strict: true }) startAt!: string;
  @ApiProperty() @IsISO8601({ strict: true }) endAt!: string;
}
export class StaffShiftDto {
  @ApiPropertyOptional({ enum: ['shift', 'absence'] })
  @IsOptional()
  @IsIn(['shift', 'absence'])
  kind?: 'shift' | 'absence';
  @ApiPropertyOptional({ enum: ['vacation', 'sickness', 'other'] })
  @IsOptional()
  @IsIn(['vacation', 'sickness', 'other'])
  absenceType?: 'vacation' | 'sickness' | 'other';
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiProperty() @IsUUID() userId!: string;
  @ApiProperty() @IsISO8601({ strict: true }) startAt!: string;
  @ApiProperty() @IsISO8601({ strict: true }) endAt!: string;
  @ApiProperty({ enum: ['planned', 'confirmed', 'cancelled'] })
  @IsIn(['planned', 'confirmed', 'cancelled'])
  status!: 'planned' | 'confirmed' | 'cancelled';
  @ApiPropertyOptional({ type: [ShiftBreakDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ShiftBreakDto)
  breaks?: ShiftBreakDto[];
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  maxOpenTasks?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
  @ApiProperty() @IsString() @MaxLength(200) idempotencyKey!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedRevision?: number;
}
export class StaffShiftRequestDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiProperty() @IsString() @MaxLength(200) idempotencyKey!: string;
}

export class StaffShiftTemplateDto {
  @IsUUID() propertyId!: string;
  @IsUUID() userId!: string;
  @IsString() @MaxLength(100) name!: string;
  @IsArray()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  weekdays!: number[];
  @IsString() @MaxLength(5) startTime!: string;
  @IsString() @MaxLength(5) endTime!: string;
  @IsInt() @Min(0) @Max(1) overnight!: number;
  @IsOptional() @IsInt() @Min(1) @Max(1000) maxOpenTasks?: number;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsString() @MaxLength(200) idempotencyKey!: string;
  @IsOptional() @IsInt() @Min(1) expectedRevision?: number;
}
export class ApplyShiftTemplateDto {
  @IsUUID() propertyId!: string;
  @IsString() @MaxLength(10) startDate!: string;
  @IsString() @MaxLength(10) endDate!: string;
  @IsIn(['planned', 'confirmed']) status!: 'planned' | 'confirmed';
  @IsInt() @Min(1) expectedRevision!: number;
  @IsString() @MaxLength(150) idempotencyKey!: string;
}
