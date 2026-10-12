import { ApiProperty } from '@nestjs/swagger';
import { IsUUID, IsInt, Min, IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class PricingMutationDto {
  @ApiProperty({ description: 'Immutable UUID retry key; replays return the original committed response.' })
  @IsUUID() requestId!: string;
  @ApiProperty({ description: 'Current plan revision (0 when creating a plan); queue actions use proposal revision.' })
  @IsInt() @Min(0) expectedRevision!: number;
  @ApiProperty({ description: 'Business justification, retained in audit/history.' })
  @IsString() @IsNotEmpty() @MaxLength(1000) reason!: string;
}
