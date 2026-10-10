import { IsInt, IsObject, IsUUID, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
export class UpdateWorkspaceDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiProperty() @IsInt() @Min(0) expectedRevision!: number;
  @ApiProperty() @IsObject() layout!: Record<string, unknown>;
}
