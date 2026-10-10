import { IsUUID, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsCanonicalCalendarDate, IsAfterCheckIn } from '@telivityhaip/shared';

export class ReservationQuoteDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiProperty() @IsUUID() roomTypeId!: string;
  @ApiProperty() @IsUUID() ratePlanId!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() guestId?: string;
  @ApiProperty({ example: '2026-10-10' }) @IsCanonicalCalendarDate() checkIn!: string;
  @ApiProperty({ example: '2026-10-12' }) @IsCanonicalCalendarDate() @IsAfterCheckIn() checkOut!: string;
}
