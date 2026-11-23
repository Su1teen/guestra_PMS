import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator';
import { PRICE_TYPES } from '../reservation-adjustments.service';

export class SetPriceTypeDto {
  @ApiProperty({ enum: PRICE_TYPES }) @IsIn(PRICE_TYPES as unknown as string[]) priceType!: string;
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @ApiPropertyOptional({ description: 'Required for barter' }) @IsOptional() @IsString() @MaxLength(200) counterparty?: string;
}

export class CorrectClosedReservationDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\d+(\.\d{1,2})?$/) totalAmount?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) adults?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) children?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) specialRequests?: string;
}
