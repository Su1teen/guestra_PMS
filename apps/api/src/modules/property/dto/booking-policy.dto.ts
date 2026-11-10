import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';

export class ChildAgeBandDto {
  @ApiPropertyOptional({ example: 'child_0_5' }) @IsString() @Matches(/^[a-z0-9_]{1,30}$/) code!: string;
  @ApiPropertyOptional({ example: '0–5' }) @IsString() @MaxLength(30) label!: string;
  @ApiPropertyOptional() @IsInt() @Min(0) @Max(17) minAge!: number;
  @ApiPropertyOptional() @IsInt() @Min(0) @Max(17) maxAge!: number;
  @ApiPropertyOptional() @IsBoolean() occupiesBed!: boolean;
}

/** Hotel policy for tentative bookings, guarantees and child pricing. Omitted fields keep their value; null clears. */
export class BookingPolicyDto {
  @ApiPropertyOptional({ type: [ChildAgeBandDto] }) @IsOptional() @IsArray() @ArrayMaxSize(6)
  @ValidateNested({ each: true }) @Type(() => ChildAgeBandDto) childAgeBands?: ChildAgeBandDto[] | null;
  @ApiPropertyOptional({ description: 'Option hold in hours; null = no automatic deadline' }) @IsOptional() @IsInt() @Min(1) @Max(24 * 60)
  optionHoldHours?: number | null;
  @ApiPropertyOptional({ enum: ['cancel', 'notify'] }) @IsOptional() @IsIn(['cancel', 'notify']) optionExpiryAction?: 'cancel' | 'notify' | null;
  @ApiPropertyOptional({ description: 'Guarantee share of the stay total that confirms automatically; null = manual confirmation' })
  @IsOptional() @IsNumber() @Min(0) @Max(100) depositPercentage?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() autoSendConfirmation?: boolean | null;
}
