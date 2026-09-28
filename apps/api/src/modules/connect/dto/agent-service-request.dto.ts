import { IsEnum, IsInt, IsObject, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IntegrationContextDto } from './integration-context.dto';

const requestTypes = ['maintenance', 'turndown', 'deep_clean', 'checkout', 'stayover', 'inspection', 'service_request', 'housekeeping', 'late_checkout', 'early_checkin', 'extra_towel', 'extra_blanket', 'spa_booking', 'restaurant_request', 'transfer', 'breakfast', 'technical_problem', 'other'] as const;

export class AgentServiceRequestDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiProperty() @IsUUID() guestId!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() reservationId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() roomId?: string;
  @ApiProperty({ enum: requestTypes }) @IsEnum(requestTypes) type!: typeof requestTypes[number];
  @ApiProperty() @IsString() title!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() department?: string;
  @ApiPropertyOptional({ default: 0 }) @IsOptional() @IsInt() @Min(0) @Max(3) priority?: number;
  @ApiProperty() @IsString() idempotencyKey!: string;
  @ApiPropertyOptional({ type: IntegrationContextDto }) @IsOptional() @IsObject() integrationContext?: IntegrationContextDto;
}
