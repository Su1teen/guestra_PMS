import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { IsAfterCheckIn, IsCanonicalCalendarDate } from '@telivityhaip/shared';
import { BookingConfirmationOptionsDto } from './booking-confirmation-options.dto';
import { ChildAgesProperty } from './child-ages';

/** One category line of a group: N identical rooms with the same tariff and party per room. */
export class GroupRoomLineDto {
  @ApiProperty() @IsUUID() roomTypeId!: string;
  @ApiProperty() @IsUUID() ratePlanId!: string;
  @ApiProperty({ minimum: 1, maximum: 50 }) @IsInt() @Min(1) @Max(50) quantity!: number;
  @ApiPropertyOptional({ description: 'Adults per room' }) @IsOptional() @IsInt() @Min(1) @Max(20) adults?: number;
  @ApiPropertyOptional({ description: 'Children per room' }) @IsOptional() @IsInt() @Min(0) @Max(20) children?: number;
  @ChildAgesProperty() childAges?: number[];
  @ApiPropertyOptional({ type: [String], description: 'Rooms to hold for this line (up to quantity); the rest stay unassigned' })
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsUUID('all', { each: true }) roomIds?: string[];
  @ApiPropertyOptional({ description: 'Primary guest of these rooms; defaults to the group contact' }) @IsOptional() @IsUUID() guestId?: string;
}

export class CreateGroupBookingDto extends BookingConfirmationOptionsDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiProperty({ description: 'Client-generated id; retries return the same booking' }) @IsUUID() requestId!: string;
  @ApiProperty({ description: 'Group contact (booker)' }) @IsUUID() guestId!: string;
  @ApiProperty({ example: 'Свадьба Ахметовых' }) @IsString() @MinLength(1) @MaxLength(255) groupName!: string;
  @ApiPropertyOptional({ description: 'Company / group profile' }) @IsOptional() @IsUUID() groupProfileId?: string;
  @ApiProperty({ example: '2027-05-01' }) @IsCanonicalCalendarDate() checkIn!: string;
  @ApiProperty({ example: '2027-05-03' }) @IsCanonicalCalendarDate() @IsAfterCheckIn() checkOut!: string;
  @ApiProperty({ type: [GroupRoomLineDto] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => GroupRoomLineDto)
  rooms!: GroupRoomLineDto[];
  @ApiProperty({ example: '420000.00', description: 'Quoted group total the staff accepted' }) @Matches(/^\d{1,10}(\.\d{1,2})?$/) expectedTotal!: string;
  @ApiProperty({ example: 'KZT' }) @IsString() @MaxLength(3) currencyCode!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) specialRequests?: string;
}

/** Group quote request: same lines without assignments. */
export class GroupQuoteDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiProperty() @IsCanonicalCalendarDate() checkIn!: string;
  @ApiProperty() @IsCanonicalCalendarDate() @IsAfterCheckIn() checkOut!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() guestId?: string;
  @ApiProperty({ type: [GroupRoomLineDto] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => GroupRoomLineDto)
  rooms!: GroupRoomLineDto[];
}
