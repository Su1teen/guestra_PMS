import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, ValidateNested, ArrayMaxSize } from 'class-validator';

export class CrmSyncGuestDto {
  @ApiProperty() @IsString() @MaxLength(200) customerId!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() pmsGuestId?: string;
  @ApiProperty() @IsString() @MaxLength(100) firstName!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) lastName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(255) email?: string;
}

export class CrmSyncStayDto {
  @ApiProperty() @IsString() @MaxLength(200) categoryName!: string;
  @ApiProperty() @Matches(/^\d{4}-\d{2}-\d{2}$/) arrivalDate!: string;
  @ApiProperty() @Matches(/^\d{4}-\d{2}-\d{2}$/) departureDate!: string;
  @ApiProperty() @IsInt() @Min(1) adults!: number;
  @ApiProperty() @IsInt() @Min(0) children!: number;
  @ApiProperty({ description: 'Accepted accommodation amount in major units' }) @IsNumber() @Min(0) totalAmount!: number;
  @ApiProperty() @IsString() @MaxLength(3) currencyCode!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) specialRequests?: string;
  @ApiProperty({ enum: ['pending', 'confirmed', 'checked_in', 'checked_out', 'cancelled'] })
  @IsIn(['pending', 'confirmed', 'checked_in', 'checked_out', 'cancelled']) status!: string;
}

export class CrmSyncChargeDto {
  @ApiProperty() @IsString() @MaxLength(200) crmLineId!: string;
  @ApiProperty() @IsString() @MaxLength(255) description!: string;
  @ApiProperty() @IsString() @MaxLength(60) category!: string;
  @ApiProperty() @IsNumber() amount!: number;
  @ApiProperty() @IsISO8601() serviceDate!: string;
}

export class CrmSyncPaymentDto {
  @ApiProperty() @IsString() @MaxLength(200) crmPaymentId!: string;
  @ApiProperty({ enum: ['card', 'transfer', 'cash'] }) @IsIn(['card', 'transfer', 'cash']) method!: string;
  @ApiProperty() @IsNumber() @Min(0.01) amount!: number;
  @ApiProperty() @IsISO8601() processedAt!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(255) reference?: string;
}

/** A CRM-side stay (new, or already mirrored from PMS) with what CRM staff added to it. */
export class CrmSyncApplyDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiProperty() @IsString() @MaxLength(200) crmReservationId!: string;
  @ApiPropertyOptional({ description: 'Set when the stay already exists in PMS' }) @IsOptional() @IsUUID() pmsReservationId?: string;
  @ApiProperty() @ValidateNested() @Type(() => CrmSyncGuestDto) guest!: CrmSyncGuestDto;
  @ApiPropertyOptional() @IsOptional() @ValidateNested() @Type(() => CrmSyncStayDto) stay?: CrmSyncStayDto;
  @ApiProperty({ type: [CrmSyncChargeDto] }) @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => CrmSyncChargeDto) charges!: CrmSyncChargeDto[];
  @ApiProperty({ type: [CrmSyncPaymentDto] }) @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => CrmSyncPaymentDto) payments!: CrmSyncPaymentDto[];
}

/** Records that a PMS guest is the CRM customer created when PMS data was mirrored. */
export class CrmSyncLinkDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiProperty() @IsUUID() pmsGuestId!: string;
  @ApiProperty() @IsString() @MaxLength(200) customerId!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() pmsReservationId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) crmReservationId?: string;
}
