import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../auth/permissions.decorator';
import { OperationsDateQueryDto, PreArrivalQueryDto } from './dto/operations.dto';
import { OperationsService } from './operations.service';

@ApiTags('operations')
@Controller('operations')
@RequirePermissions('ops.read')
export class OperationsController {
  constructor(private readonly service: OperationsService) {}

  @Get('assignees')
  @ApiOperation({ summary: 'Active staff available for operational assignment' })
  assignees(@Query() query: OperationsDateQueryDto) {
    return this.service.assignees(query.propertyId);
  }

  @Get('attention')
  @ApiOperation({ summary: 'Unified operational exceptions requiring attention' })
  attention(@Query() query: OperationsDateQueryDto) {
    return this.service.attention(query.propertyId, query.date ?? new Date().toISOString().slice(0, 10));
  }

  @Get('pre-arrivals')
  @ApiOperation({ summary: 'Pre-arrival readiness generated from live PMS state' })
  preArrivals(@Query() query: PreArrivalQueryDto) {
    return this.service.preArrivals(query.propertyId, query.startDate, query.endDate);
  }
}
