import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { ConnectScopeGuard } from '../auth/connect-scope.guard';
import { Public } from '../auth/public.decorator';
import { ConnectRemotePaymentDto, ConnectRemotePaymentQueryDto } from '../remote-payment/dto/remote-payment.dto';
import { RemotePaymentService } from '../remote-payment/remote-payment.service';
import { ConnectV2Guard } from './connect-v2.guard';
import { ServiceCapability } from './service-capability.decorator';

/** CRM (Connect v2): the AI agent or a CRM manager sends the invoice; status is read back here. */
@ApiTags('Guestra integration v2')
@Controller()
@Public()
export class ConnectRemotePaymentController {
  constructor(private readonly remotePayments: RemotePaymentService) {}

  @Post('connect/v2/reservations/:id/remote-prepayment')
  @ApiSecurity('api-key')
  @ApiOperation({ summary: 'Send (or return the open) Kaspi invoice for the prepayment of a tentative stay' })
  @UseGuards(ApiKeyGuard, ConnectScopeGuard, ConnectV2Guard)
  @ServiceCapability('integration.write')
  create(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ConnectRemotePaymentDto) {
    return this.remotePayments.createForCustomer(dto.customerId, { propertyId: dto.propertyId, reservationId: id, phone: dto.phone,
      expectedAmount: dto.expectedAmount, source: dto.source, conversationId: dto.conversationId, requestedBy: dto.requestedBy });
  }

  @Get('connect/v2/reservations/:id/remote-prepayment')
  @ApiSecurity('api-key')
  @ApiOperation({ summary: 'Kaspi invoices of a stay of the CRM customer' })
  @UseGuards(ApiKeyGuard, ConnectScopeGuard, ConnectV2Guard)
  @ServiceCapability('integration.read')
  list(@Param('id', ParseUUIDPipe) id: string, @Query() query: ConnectRemotePaymentQueryDto) {
    return this.remotePayments.listForCustomer(query.propertyId, id, query.customerId);
  }
}
