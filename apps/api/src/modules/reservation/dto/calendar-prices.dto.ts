import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { CalendarRangeDto } from './calendar-range.dto';
export class CalendarPricesDto extends CalendarRangeDto { @ApiProperty() @IsUUID() ratePlanId!: string; }
