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
