import { IsDateString, IsInt, IsOptional, IsString, IsUUID, Min, ValidateNested, IsObject, MinLength, MaxLength, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsMoneyString } from '../../../common/validation/is-money-string.validator';
import { IntegrationContextDto } from './integration-context.dto';

export class AgentServiceAvailabilityDto {
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) quantity?: number;
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiProperty() @IsUUID() serviceId!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() guestId?: string;
  @ApiProperty({ example: '2026-10-01T18:00:00.000Z' }) @IsDateString() startAt!: string;
  @ApiProperty({ example: '2026-10-01T19:00:00.000Z' }) @IsDateString() endAt!: string;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) participants?: number;
}

export class AgentServiceBookDto extends AgentServiceAvailabilityDto {
  @ApiPropertyOptional() @IsOptional() @IsMoneyString({ allowZero: true }) expectedTotal?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() reservationId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() guestFirstName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() guestLastName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() guestEmail?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() guestPhone?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(200) idempotencyKey!: string;
  @ApiPropertyOptional({ type: IntegrationContextDto }) @IsOptional() @IsObject() @ValidateNested() @Type(() => IntegrationContextDto) integrationContext?: IntegrationContextDto;
}
