import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsUUID } from 'class-validator';

export class MergeGuestsDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiProperty({ description: 'Profile that will remain active' }) @IsUUID() targetGuestId!: string;
  @ApiProperty({ description: 'Explicit confirmation after UI comparison' }) @IsBoolean() confirmed!: boolean;
}
