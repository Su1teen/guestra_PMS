import {
  IsUUID,
  IsDateString,
  IsOptional,
  IsIn,
  IsInt,
  Min,
  IsString,
  MaxLength,
  IsArray,
  ArrayMaxSize,
  Matches,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { MANAGEMENT_REVENUE_ARTICLES, type ManagementEntry } from "@telivityhaip/shared";
export class ManagementReportQueryDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiProperty() @IsDateString() startDate!: string;
  @ApiProperty() @IsDateString() endDate!: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() date?: string;
}
export class ManagementOperationsQueryDto extends ManagementReportQueryDto {
  @ApiPropertyOptional({ enum: MANAGEMENT_REVENUE_ARTICLES })
  @IsOptional() @IsIn(MANAGEMENT_REVENUE_ARTICLES) article?: string;
  @ApiPropertyOptional()
  @IsOptional() @IsString() @Matches(/^\d{1,6}$/) offset?: string;
}
export class ManagementInputDto extends ManagementReportQueryDto {
  @ApiProperty({ enum: ["budget", "expenses"] })
  @IsIn(["budget", "expenses"])
  kind!: "budget" | "expenses";
  @ApiProperty() @IsInt() @Min(0) expectedRevision!: number;
  @ApiProperty() @IsString() @MaxLength(3) currencyCode!: string;
  @ApiProperty() @IsArray() @ArrayMaxSize(5000) entries!: ManagementEntry[];
  @ApiProperty() @IsString() @MaxLength(1000) reason!: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() coverageThrough?: string;
}
