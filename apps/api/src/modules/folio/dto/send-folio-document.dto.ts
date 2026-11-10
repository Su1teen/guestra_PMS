import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional } from 'class-validator';

export class SendFolioDocumentDto {
  @ApiPropertyOptional({ description: 'Defaults to the guest email on file' })
  @IsOptional() @IsEmail() email?: string;
}
