import { IsEmail, IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ChildAgesProperty } from './child-ages';

export class ReservationOccupancyDto {
  @ApiProperty() @IsInt() @Min(1) @Max(20) adults!: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(20) children?: number;
  @ChildAgesProperty() childAges?: number[];
}

export class SendConfirmationDto {
  @ApiPropertyOptional({ description: 'Defaults to the guest email on file' })
  @IsOptional() @IsEmail() email?: string;

  @ApiPropertyOptional({ description: 'Defaults to the guest phone on file (SMS channel)' })
  @IsOptional() @Matches(/^\+?[0-9 ()-]{6,20}$/) phone?: string;

  @ApiPropertyOptional({ enum: ['email', 'sms'], default: 'email' })
  @IsOptional() @IsIn(['email', 'sms']) channel?: 'email' | 'sms';

  @ApiPropertyOptional({ enum: ['proposal', 'confirmation'], description: 'Defaults to proposal for tentative bookings, confirmation otherwise' })
  @IsOptional() @IsIn(['proposal', 'confirmation']) kind?: 'proposal' | 'confirmation';
}
