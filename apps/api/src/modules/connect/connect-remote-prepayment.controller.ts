import {
  BadRequestException, Body, Controller, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiProperty, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { ConnectScopeGuard } from '../auth/connect-scope.guard';
import { Public } from '../auth/public.decorator';
import { ConnectRemotePrepaymentService } from './connect-remote-prepayment.service';
import { ConnectV2Guard } from './connect-v2.guard';
import { ServiceCapability } from './service-capability.decorator';

class CreateRemotePrepaymentDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(200) customerId!: string;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(40) phone!: string;
  @ApiProperty() @Matches(/^[1-9]\d{0,9}\.00$/) expectedAmount!: string;
}

@ApiTags('Guestra integration v2')
@Controller()
@Public()
export class ConnectRemotePrepaymentController {
  constructor(private readonly prepayments: ConnectRemotePrepaymentService) {}

  @Post('connect/v2/reservations/:id/remote-prepayment')
  @ApiSecurity('api-key')
  @ApiOperation({ summary: 'Create or retrieve a test phone invoice for an existing tentative reservation' })
  @UseGuards(ApiKeyGuard, ConnectScopeGuard, ConnectV2Guard)
  @ServiceCapability('integration.write')
  create(@Param('id', ParseUUIDPipe) reservationId: string, @Body() dto: CreateRemotePrepaymentDto) {
    return this.prepayments.create(reservationId, dto.propertyId, dto.customerId, dto.phone, dto.expectedAmount);
  }

  @Post('webhooks/qutpay')
  @HttpCode(204)
  @ApiExcludeEndpoint()
  async webhook(@Req() request: Request, @Headers('x-webhook-timestamp') timestamp: string,
    @Headers('x-webhook-signature') signature: string) {
    if (!Buffer.isBuffer(request.body)) throw new BadRequestException('RAW_WEBHOOK_BODY_REQUIRED');
    await this.prepayments.webhook(request.body, timestamp, signature);
  }
}
