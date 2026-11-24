import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

/** Staff: send the guest a Kaspi invoice for the prepayment still due. */
export class CreateRemotePaymentDto {
  @ApiProperty({ example: '+7 701 123 45 67', description: 'Guest Kaspi number (Kazakhstan mobile)' })
  @IsString() @IsNotEmpty() @MaxLength(40) phone!: string;

  @ApiPropertyOptional({ example: '22500.00', description: 'Amount shown to the guest; rejected if the amount due differs' })
  @IsOptional() @Matches(/^[1-9]\d{0,9}\.00$/) expectedAmount?: string;
}

/** CRM (Connect v2): invoice for a stay of a CRM customer. */
export class ConnectRemotePaymentDto extends CreateRemotePaymentDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(200) customerId!: string;
  @ApiProperty({ enum: ['agent', 'staff'] }) @IsIn(['agent', 'staff']) source!: 'agent' | 'staff';
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) conversationId?: string;
  @ApiPropertyOptional({ description: 'CRM employee or agent run that asked for the invoice' })
  @IsOptional() @IsString() @MaxLength(200) requestedBy?: string;
}

export class ConnectRemotePaymentQueryDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(200) customerId!: string;
}
