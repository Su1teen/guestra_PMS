import {
  BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuditActorCtx, type AuditActor } from '../../common/audit/audit-actor';
import { RequirePermissions } from '../auth/permissions.decorator';
import { Public } from '../auth/public.decorator';
import { CreateRemotePaymentDto } from './dto/remote-payment.dto';
import { RemotePaymentService } from './remote-payment.service';

/** Staff: Kaspi invoices of a stay (send, withdraw, check now). */
@ApiTags('Remote payments')
@Controller()
export class RemotePaymentController {
  constructor(private readonly remotePayments: RemotePaymentService) {}

  @Get('reservations/:id/remote-payments')
  @RequirePermissions('reservations.read', 'folios.read')
  @ApiOperation({ summary: 'Kaspi invoices sent for this stay, newest first' })
  @ApiQuery({ name: 'propertyId', required: true })
  list(@Param('id', ParseUUIDPipe) id: string, @Query('propertyId', ParseUUIDPipe) propertyId: string) {
    return this.remotePayments.listForReservation(propertyId, id);
  }

  @Post('reservations/:id/remote-payments')
  @RequirePermissions('reservations.write', 'folios.manage')
  @ApiOperation({ summary: 'Send the guest a Kaspi invoice for the prepayment still due (or return the open one)' })
  @ApiQuery({ name: 'propertyId', required: true })
  create(@Param('id', ParseUUIDPipe) id: string, @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Body() dto: CreateRemotePaymentDto, @AuditActorCtx() actor: AuditActor) {
    return this.remotePayments.create({ propertyId, reservationId: id, phone: dto.phone, expectedAmount: dto.expectedAmount,
      source: 'staff', requestedBy: actor.userEmail ?? actor.userId ?? undefined });
  }

  @Post('remote-payments/:id/cancel')
  @RequirePermissions('reservations.write', 'folios.manage')
  @ApiOperation({ summary: 'Withdraw an open Kaspi invoice' })
  @ApiQuery({ name: 'propertyId', required: true })
  cancel(@Param('id', ParseUUIDPipe) id: string, @Query('propertyId', ParseUUIDPipe) propertyId: string, @AuditActorCtx() actor: AuditActor) {
    return this.remotePayments.cancel(propertyId, id, actor);
  }

  @Post('remote-payments/:id/refresh')
  @RequirePermissions('reservations.read', 'folios.read')
  @ApiOperation({ summary: 'Read the invoice from the payment provider now' })
  @ApiQuery({ name: 'propertyId', required: true })
  refresh(@Param('id', ParseUUIDPipe) id: string, @Query('propertyId', ParseUUIDPipe) propertyId: string) {
    return this.remotePayments.refresh(propertyId, id);
  }
}

/**
 * Payment provider callback. Public (signed with the shared webhook secret); scoped by the trusted
 * invoice id we stored, never by ids in the body.
 */
@Controller()
@Public()
export class QutPayWebhookController {
  constructor(private readonly remotePayments: RemotePaymentService) {}

  @Post('webhooks/qutpay')
  @HttpCode(204)
  @ApiExcludeEndpoint()
  async receive(@Req() request: Request, @Headers('x-webhook-timestamp') timestamp: string,
    @Headers('x-webhook-signature') signature: string) {
    if (!Buffer.isBuffer(request.body)) throw new BadRequestException('RAW_WEBHOOK_BODY_REQUIRED');
    await this.remotePayments.handleWebhook(request.body, timestamp, signature);
  }
}
