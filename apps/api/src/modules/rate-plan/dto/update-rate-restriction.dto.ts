import { PartialType, OmitType, IntersectionType } from '@nestjs/swagger';
import { CreateRateRestrictionDto } from './create-rate-restriction.dto';
import { PricingMutationDto } from './pricing-mutation.dto';

export class UpdateRateRestrictionDto extends PartialType(
  OmitType(CreateRateRestrictionDto, ['propertyId', 'requestId', 'expectedRevision', 'reason'] as const),
) {}

export class GuardedUpdateRateRestrictionDto extends IntersectionType(UpdateRateRestrictionDto, PricingMutationDto) {}
