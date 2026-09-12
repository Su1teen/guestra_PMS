import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsUUID } from 'class-validator';

export class OperationsDateQueryDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() date?: string;
}

export class PreArrivalQueryDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiProperty() @IsDateString() startDate!: string;
  @ApiProperty() @IsDateString() endDate!: string;
}
