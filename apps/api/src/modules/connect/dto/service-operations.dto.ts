import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { IsMoneyString } from '../../../common/validation/is-money-string.validator';
import type { ServiceSchedule } from '../service-schedule';
import { AgentServiceAvailabilityDto, AgentServiceBookDto } from './agent-service.dto';
export class StaffServiceAvailabilityDto extends AgentServiceAvailabilityDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() resourceId?: string;
}
export class StaffServiceBookDto extends AgentServiceBookDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() resourceId?: string;
}
export class ServiceMutationDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(200) idempotencyKey!: string;
}
export class ServiceConsumptionQuoteDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiProperty() @IsUUID() serviceId!: string;
  @ApiProperty() @IsDateString() @Matches(/^\d{4}-\d{2}-\d{2}$/) serviceDate!: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) quantity?: number;
  @ApiPropertyOptional() @IsOptional() @IsUUID() guestId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() reservationId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) guestFirstName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) guestLastName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) guestPhone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}
export class ServiceConsumptionDto extends ServiceConsumptionQuoteDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(200) idempotencyKey!: string;
  @ApiProperty() @IsMoneyString({ allowZero: true }) expectedTotal!: string;
  @ApiProperty({ enum: [true] }) @IsIn([true]) provided!: true;
}
export class ServiceStatusDto extends ServiceMutationDto {
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) expectedRevision!: number;
}
export class ServiceChangeDto extends ServiceStatusDto {
  @ApiPropertyOptional() @IsOptional() @IsDateString() startAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() endAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() resourceId?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) participants?: number;
}
export class ServiceResourceDto extends ServiceMutationDto {
  @ApiProperty() @IsUUID() serviceId!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(60) code!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) @Max(10000) capacity!: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1440) bufferBeforeMinutes?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1440) bufferAfterMinutes?: number;
  @ApiPropertyOptional() @IsOptional() @IsObject() schedule?: ServiceSchedule;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
export class ServiceResourceUpdateDto extends ServiceResourceDto {
  @ApiProperty() @IsDateString() expectedUpdatedAt!: string;
}
export class ServiceBlockDto extends ServiceMutationDto {
  @ApiProperty() @IsUUID() resourceId!: string;
  @ApiProperty() @IsDateString() startAt!: string;
  @ApiProperty() @IsDateString() endAt!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}
