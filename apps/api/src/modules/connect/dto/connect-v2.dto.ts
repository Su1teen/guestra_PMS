import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsUUID, IsString, IsInt, IsOptional, Min, MaxLength, Matches, IsIn } from 'class-validator';
import { AgentBookDto } from './agent-book.dto';
import { ServiceChangeDto,ServiceStatusDto } from './service-operations.dto';
import { CreateServiceRequestDto } from '../../service-requests/dto/service-request.dto';
import { Type } from 'class-transformer';
import { ValidateNested,IsObject } from 'class-validator';
import { IntegrationContextDto } from './integration-context.dto';
export class ConnectQuoteDto {
  @ApiProperty() @IsUUID() propertyId!:string;
  @ApiProperty() @IsUUID() roomTypeId!:string;
  @ApiProperty() @IsUUID() ratePlanId!:string;
  @ApiProperty() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) checkIn!:string;
  @ApiProperty() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) checkOut!:string;
  @ApiProperty() @IsInt() @Min(1) adults!:number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) children?:number;
  @ApiProperty() @IsString() @MaxLength(200) customerId!:string;
}
export class ConnectBookV2Dto extends AgentBookDto {
  @ApiProperty() @IsString() @MaxLength(200) declare idempotencyKey:string;
  @ApiProperty() @IsString() @MaxLength(20000) acceptedQuote!:string;
  @ApiProperty() @IsObject() @ValidateNested() @Type(()=>IntegrationContextDto) declare integrationContext:IntegrationContextDto;
}
export class ConnectMutationV2Dto {
  @ApiProperty() @IsUUID() propertyId!:string;
  @ApiProperty() @IsString() @MaxLength(200) idempotencyKey!:string;
  @ApiProperty() @IsString() @MaxLength(200) customerId!:string;
  @ApiProperty() @IsString() expectedUpdatedAt!:string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) reason?:string;
}
export class ConnectAmendV2Dto extends ConnectMutationV2Dto {
  @ApiProperty() @IsString() @MaxLength(20000) acceptedQuote!:string;
}
export class ConnectServiceChangeV2Dto extends ServiceChangeDto {
  @ApiProperty() @IsString() @MaxLength(200) customerId!:string;
}
export class ConnectServiceStatusV2Dto extends ServiceStatusDto {
  @ApiProperty() @IsString() @MaxLength(200) customerId!:string;
}
export class ConnectRequestV2Dto extends CreateServiceRequestDto {
  @ApiProperty() @IsString() @MaxLength(200) idempotencyKey!:string;
  @ApiProperty() @IsObject() @ValidateNested() @Type(()=>IntegrationContextDto) integrationContext!:IntegrationContextDto;
}
import {fixtureStages} from '../connect-sandbox.service';
export class ConnectFixtureDto {
 @IsUUID() propertyId!:string;
 @IsString() @MaxLength(120) fixtureId!:string;
 @IsString() @MaxLength(160) customerId!:string;
 @IsString() @MaxLength(160) conversationId!:string;
 @IsOptional() @IsString() @MaxLength(160) requestId?:string;
 @IsIn(fixtureStages) stage!:typeof fixtureStages[number];
}
