import { Controller, Get, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { ConnectScopeGuard } from '../auth/connect-scope.guard';
import { ConnectV2Guard } from './connect-v2.guard';
import { ServiceCapability } from './service-capability.decorator';
import { PropertyService } from '../property/property.service';

/** Booking guarantee and cancellation terms of a property, as configured in its booking policy. */
@ApiTags('Guestra integration v2') @ApiSecurity('api-key') @Controller('connect/v2/booking-terms') @Public()
@UseGuards(ApiKeyGuard, ConnectScopeGuard, ConnectV2Guard)
export class CrmBookingTermsController {
  constructor(private readonly properties: PropertyService) {}

  @Get() @ServiceCapability('integration.read') @ApiOperation({ summary: 'Prepayment that confirms a booking and the late-cancellation window' })
  async terms(@Query('propertyId', ParseUUIDPipe) propertyId: string) {
    const policy = await this.properties.bookingPolicy(propertyId);
    return {
      propertyId,
      depositPercentage: policy.depositPercentage,
      lateCancellationHours: policy.lateCancellationHours ?? 24,
      optionHoldMinutes: policy.optionHoldMinutes ?? (policy.optionHoldHours != null ? policy.optionHoldHours * 60 : null),
      optionExpiryAction: policy.optionExpiryAction,
    };
  }
}
