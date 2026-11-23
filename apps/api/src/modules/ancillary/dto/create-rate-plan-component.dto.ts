import {
  IsNotEmpty,
  IsOptional,
  IsUUID,
  IsBoolean,
  IsInt,
  Min,
  IsIn,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsMoneyString } from '../../../common/validation/is-money-string.validator';

export class CreateRatePlanComponentDto {
  @ApiProperty({ description: 'Property ID (required for multi-tenancy)' })
  @IsUUID()
  @IsNotEmpty()
  propertyId!: string;

  @ApiProperty()
  @IsUUID()
  @IsNotEmpty()
  ratePlanId!: string;

  @ApiProperty()
  @IsUUID()
  @IsNotEmpty()
  serviceId!: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity?: number;

  @ApiPropertyOptional({
    description: 'Overrides catalog price for this component when set',
  })
  @IsOptional()
  @IsMoneyString({ allowZero: true })
  amountOverride?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  includedInRate?: boolean;

  @ApiPropertyOptional({ enum: ['per_guest_per_night', 'per_guest_per_stay', 'per_stay', 'per_night'], description: 'How the component is counted in the revenue split' })
  @IsOptional()
  @IsIn(['per_guest_per_night', 'per_guest_per_stay', 'per_stay', 'per_night'])
  basis?: 'per_guest_per_night' | 'per_guest_per_stay' | 'per_stay' | 'per_night';

  @ApiPropertyOptional({ description: 'Value of one unit in the revenue split (reports)' })
  @IsOptional()
  @IsMoneyString({ allowZero: true })
  allocationAmount?: string;

  @ApiPropertyOptional({ description: 'Cost of one unit to the hotel (management report)' })
  @IsOptional()
  @IsMoneyString({ allowZero: true })
  unitCost?: string;

  @ApiPropertyOptional({ enum: ['fnb', 'bath', 'spa', 'other'], description: 'Report revenue category; default from the service charge type' })
  @IsOptional()
  @IsIn(['fnb', 'bath', 'spa', 'other'])
  revenueCategory?: 'fnb' | 'bath' | 'spa' | 'other';
}
