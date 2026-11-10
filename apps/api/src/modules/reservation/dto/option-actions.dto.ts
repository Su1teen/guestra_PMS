import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsDateString, IsIn, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import { IsMoneyString } from '../../../common/validation/is-money-string.validator';
import { MANUAL_PREPAYMENT_METHODS, type ManualPrepaymentMethod } from '../guarantee';

/** POST :id/prepayment — front desk marks a prepayment received outside a payment gateway. */
export class RecordPrepaymentDto {
  @ApiProperty({ example: '45000.00' }) @IsMoneyString() amount!: string;
  @ApiProperty({ enum: MANUAL_PREPAYMENT_METHODS }) @IsIn(MANUAL_PREPAYMENT_METHODS as unknown as string[]) method!: ManualPrepaymentMethod;
  @ApiPropertyOptional({ description: 'Transfer / receipt / slip number' }) @IsOptional() @IsString() @MaxLength(200) reference?: string;
  @ApiPropertyOptional({ description: 'When the money was received (not in the future)' }) @IsOptional() @IsDateString() receivedAt?: string;
}

/** PATCH :id/option — extend or remove the option deadline, or change the guarantee amount. */
export class ChangeOptionDto {
  @ApiPropertyOptional({ nullable: true, description: 'New deadline; null removes it' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() optionUntil?: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'New guarantee amount; null = manual confirmation only' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsMoneyString({ allowZero: true }) requiredDeposit?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() wholeBooking?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

/** POST :id/option/release — staff releases an unconfirmed booking by hand. */
export class ReleaseOptionDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() wholeBooking?: boolean;
}

/** POST :id/option/remind — resend the proposal to the guest as a reminder. */
export class RemindGuestDto {
  @ApiPropertyOptional({ enum: ['email', 'sms'] }) @IsOptional() @IsIn(['email', 'sms']) channel?: 'email' | 'sms';
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(320) to?: string;
}
