import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpgradeReservationDto {
  @ApiProperty() @IsUUID() roomTypeId!: string;

  @ApiPropertyOptional({ description: 'Defaults to the active plan of the new room type with the same code' })
  @IsOptional() @IsUUID() ratePlanId?: string;

  @ApiPropertyOptional({ description: 'Room of the new type to assign immediately' })
  @IsOptional() @IsUUID() roomId?: string;

  @ApiProperty({ enum: ['keep', 'reprice', 'custom'],
    description: 'keep = complimentary (stay total unchanged); reprice = tariff of the new room; custom = customTotal' })
  @IsIn(['keep', 'reprice', 'custom'])
  pricing!: 'keep' | 'reprice' | 'custom';

  @ApiPropertyOptional({ example: '60000.00' })
  @IsOptional() @IsString() @MaxLength(20)
  customTotal?: string;

  @ApiProperty({ example: 'Complimentary upgrade for repeat guest' })
  @IsString() @MinLength(3) @MaxLength(500)
  reason!: string;
}
