import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { IsMoneyString } from '../../../common/validation/is-money-string.validator';

export class StayReasonDto {
  @ApiProperty({ description: 'Why: shown in the audit trail and reports' })
  @IsString() @IsNotEmpty() @MaxLength(500)
  reason!: string;
}

export class StayRetainDto extends StayReasonDto {
  @ApiPropertyOptional({ description: 'Amount to retain; default all received money not yet refunded or retained' })
  @IsOptional() @IsMoneyString()
  amount?: string;
}

export class StayRefundDto extends StayReasonDto {
  @ApiProperty() @IsUUID()
  paymentId!: string;

  @ApiPropertyOptional({ description: 'Amount to refund; default the whole payment' })
  @IsOptional() @IsMoneyString()
  amount?: string;
}
