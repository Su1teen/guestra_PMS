import { IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Another room in the same booking (group / family booking under one confirmation number). */
export class AddBookingRoomDto {
  @ApiProperty({ description: 'Client-generated id; retries return the same room' }) @IsUUID() requestId!: string;
  @ApiProperty() @IsUUID() roomTypeId!: string;
  @ApiProperty() @IsUUID() ratePlanId!: string;
  @ApiPropertyOptional({ description: 'Primary guest of the new room; defaults to the booker' }) @IsOptional() @IsUUID() guestId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() roomId?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(20) adults?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(20) children?: number;
  @ApiProperty({ example: '42000.00', description: 'Quoted total the staff accepted' })
  @Matches(/^\d{1,10}(\.\d{1,2})?$/) expectedTotal!: string;
  @ApiProperty({ example: 'KZT' }) @IsString() @MaxLength(3) currencyCode!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) specialRequests?: string;
}
