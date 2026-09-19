import { IsDateString, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class BeCheckRoomDto {
  @ApiProperty()
  @IsUUID()
  roomTypeId!: string;

  @ApiProperty({ example: 'A-12' })
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  roomNumber!: string;

  @ApiProperty({ example: '2026-07-01' })
  @IsDateString()
  checkIn!: string;

  @ApiProperty({ example: '2026-07-04' })
  @IsDateString()
  checkOut!: string;
}
