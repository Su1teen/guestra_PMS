import { IsBoolean, IsOptional, IsUUID } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsCanonicalCalendarDate, IsAfterCheckIn } from '@telivityhaip/shared';
export class CalendarRangeDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiProperty() @IsCanonicalCalendarDate() checkIn!: string;
  @ApiProperty() @IsCanonicalCalendarDate() @IsAfterCheckIn() checkOut!: string;
  /** Also return checked-out, cancelled and no-show stays for the history view; they never occupy a room. */
  @ApiPropertyOptional() @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() includeHistory?: boolean;
}
