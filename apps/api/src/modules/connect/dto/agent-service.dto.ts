import { IsDateString, IsInt, IsOptional, IsString, IsUUID, Min, ValidateNested, IsObject } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IntegrationContextDto } from './integration-context.dto';

export class AgentServiceAvailabilityDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiProperty() @IsUUID() serviceId!: string;
  @ApiProperty({ example: '2026-10-01T18:00:00.000Z' }) @IsDateString() startAt!: string;
  @ApiProperty({ example: '2026-10-01T19:00:00.000Z' }) @IsDateString() endAt!: string;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) participants?: number;
}

export class AgentServiceBookDto extends AgentServiceAvailabilityDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() guestId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() reservationId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() guestFirstName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() guestLastName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() guestEmail?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() guestPhone?: string;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) quantity?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiProperty() @IsString() idempotencyKey!: string;
  @ApiPropertyOptional({ type: IntegrationContextDto }) @IsOptional() @IsObject() integrationContext?: IntegrationContextDto;
}
