import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ReservationQuoteDto } from './reservation-quote.dto';
import { IsMoneyString } from '../../../common/validation/is-money-string.validator';
export class StaffCreateReservationDto extends ReservationQuoteDto {
  @ApiProperty() @IsUUID() guestId!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() roomId?: string;
  @ApiProperty() @IsUUID() requestId!: string;
  @ApiProperty() @IsMoneyString({ allowZero: true }) expectedTotal!: string;
  @ApiProperty() @IsString() @MaxLength(3) currencyCode!: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(100) adults?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(100) children?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) specialRequests?: string;
}
