import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ReservationPriceDto {
  @ApiProperty({ enum: ['total', 'discount_percent', 'discount_amount', 'reset'],
    description: 'total = new stay total; discounts apply to the current tariff; reset returns to the tariff' })
  @IsIn(['total', 'discount_percent', 'discount_amount', 'reset'])
  mode!: 'total' | 'discount_percent' | 'discount_amount' | 'reset';

  @ApiPropertyOptional({ example: '45000.00', description: 'Amount or percentage, as a decimal string' })
  @IsOptional() @IsString() @MaxLength(20)
  value?: string;

  @ApiProperty({ example: 'Corporate agreement' })
  @IsString() @MinLength(3) @MaxLength(500)
  reason!: string;
}
