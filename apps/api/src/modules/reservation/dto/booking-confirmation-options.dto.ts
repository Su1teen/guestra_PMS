import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsISO8601, IsOptional, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';
import { GUARANTEE_TYPES, type GuaranteeType } from '../guarantee';

/** How a new staff booking starts: tentative (option, waiting for a guarantee) or confirmed right away. */
export class BookingConfirmationOptionsDto {
  @ApiPropertyOptional({ enum: ['tentative', 'confirmed'], default: 'tentative',
    description: 'tentative = option waiting for a guarantee; confirmed = guarantee already received' })
  @IsOptional() @IsIn(['tentative', 'confirmed']) confirmation?: 'tentative' | 'confirmed';

  @ApiPropertyOptional({ enum: GUARANTEE_TYPES, description: 'Guarantee of a confirmed booking' })
  @IsOptional() @IsIn(GUARANTEE_TYPES as unknown as string[]) guaranteeType?: GuaranteeType;

  @ApiPropertyOptional({ description: 'Required when confirming without a guarantee' })
  @IsOptional() @IsString() @MaxLength(500) guaranteeReason?: string;

  @ApiPropertyOptional({ nullable: true, description: 'Option deadline (ISO date-time); null = no deadline; omitted = property default' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsISO8601() optionUntil?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '30000.00', description: 'Guarantee that confirms automatically; null = manual only; omitted = property deposit %' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(/^\d{1,10}(\.\d{1,2})?$/) requiredDeposit?: string | null;

  @ApiPropertyOptional({ description: 'Send the guest confirmation right after creating a confirmed booking' })
  @IsOptional() @IsBoolean() notifyGuest?: boolean;
}
