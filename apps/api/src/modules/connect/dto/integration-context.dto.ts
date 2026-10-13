import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Opaque CRM correlation data, intentionally free of CRM business semantics. */
export class IntegrationContextDto {
  /** Internal proof included in booking replay fingerprints, never a credential. */
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64)
  acceptedQuoteHash?: string;
  @ApiPropertyOptional({ example: 'guestra_crm' })
  @IsOptional() @IsString() @MaxLength(60)
  sourceSystem?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200)
  customerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200)
  requestId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200)
  offerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200)
  reservationId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200)
  conversationId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200)
  operationId?: string;
}
