import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { PRICE_ADJUSTMENT_TYPES, PRICE_RULE_KINDS } from '../price-rules';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT = /^-?\d+(\.\d{1,2})?$/;

export class PriceCalendarQueryDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiProperty({ example: '2026-12-01' }) @Matches(DATE) from!: string;
  @ApiProperty({ example: '2026-12-31' }) @Matches(DATE) to!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() roomTypeId?: string;
}

export class PriceRuleDto {
  @ApiProperty({ enum: PRICE_RULE_KINDS }) @IsIn(PRICE_RULE_KINDS as unknown as string[]) kind!: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @ApiProperty() @Matches(DATE) startDate!: string;
  @ApiProperty() @Matches(DATE) endDate!: string;
  @ApiPropertyOptional({ type: [String], description: 'Empty = every room type' }) @IsOptional() @IsArray() @ArrayMaxSize(50) @IsUUID('all', { each: true }) roomTypeIds?: string[];
  @ApiProperty({ enum: PRICE_ADJUSTMENT_TYPES }) @IsIn(PRICE_ADJUSTMENT_TYPES as unknown as string[]) adjustmentType!: string;
  @ApiProperty({ description: 'Percent (e.g. 20 or -10) or a fixed nightly price' }) @Matches(AMOUNT) value!: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

export class UpdatePriceRuleDto {
  @ApiPropertyOptional({ enum: PRICE_RULE_KINDS }) @IsOptional() @IsIn(PRICE_RULE_KINDS as unknown as string[]) kind?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(DATE) startDate?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(DATE) endDate?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(50) @IsUUID('all', { each: true }) roomTypeIds?: string[];
  @ApiPropertyOptional({ enum: PRICE_ADJUSTMENT_TYPES }) @IsOptional() @IsIn(PRICE_ADJUSTMENT_TYPES as unknown as string[]) adjustmentType?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(AMOUNT) value?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() expectedRevision?: number;
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

export class PriceBoundsDto {
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_o, v) => v !== null) @Matches(/^\d+(\.\d{1,2})?$/) minPrice?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf((_o, v) => v !== null) @Matches(/^\d+(\.\d{1,2})?$/) maxPrice?: string | null;
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}
