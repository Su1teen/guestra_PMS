import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { IsCanonicalCalendarDate, IsAfterCheckIn } from '@telivityhaip/shared';
export class CalendarRangeDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiProperty() @IsCanonicalCalendarDate() checkIn!: string;
  @ApiProperty() @IsCanonicalCalendarDate() @IsAfterCheckIn() checkOut!: string;
}
