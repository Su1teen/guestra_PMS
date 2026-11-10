import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { GUARANTEE_TYPES, type GuaranteeType } from '../guarantee';

/** Body of PATCH :id/confirm. Empty body keeps the previous behaviour (plain confirmation). */
export class ConfirmReservationDto {
  @ApiPropertyOptional({ enum: GUARANTEE_TYPES }) @IsOptional() @IsIn(GUARANTEE_TYPES as unknown as string[]) guaranteeType?: GuaranteeType;
  @ApiPropertyOptional({ description: 'Required for guaranteeType = none' }) @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @ApiPropertyOptional({ description: 'Send the guest confirmation; defaults to the property auto-send setting' }) @IsOptional() @IsBoolean() notifyGuest?: boolean;
  @ApiPropertyOptional({ description: 'Confirm every unconfirmed room of the booking (group / multi-room)' }) @IsOptional() @IsBoolean() wholeBooking?: boolean;
}
