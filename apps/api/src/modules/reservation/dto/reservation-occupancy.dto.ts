import { IsEmail, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ReservationOccupancyDto {
  @ApiProperty() @IsInt() @Min(1) @Max(20) adults!: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(20) children?: number;
}

export class SendConfirmationDto {
  @ApiPropertyOptional({ description: 'Defaults to the guest email on file' })
  @IsOptional() @IsEmail() email?: string;
}
