import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../auth/permissions.decorator';
import { AuditActorCtx, type AuditActor } from '../../common/audit/audit-actor';
import { PriceCalendarService } from './price-calendar.service';
import { PriceBoundsDto, PriceCalendarQueryDto, PriceRuleDto, UpdatePriceRuleDto } from './dto/price-calendar.dto';

/** «Календарь цен»: seasons, holidays, promos and min / max per room type over the existing rate plans. */
@ApiTags('price-calendar')
@Controller('price-calendar')
export class PriceCalendarController {
  constructor(private readonly calendar: PriceCalendarService) {}

  @Get()
  @RequirePermissions('rateplans.read')
  @ApiOperation({ summary: 'Final nightly price per base plan with the reasons («почему такая цена»)' })
  get(@Query() query: PriceCalendarQueryDto) {
    return this.calendar.calendar(query.propertyId, query.from, query.to, query.roomTypeId);
  }

  @Get('history')
  @RequirePermissions('rateplans.read')
  @ApiOperation({ summary: 'Change log of price rules and min / max prices' })
  history(@Query('propertyId', ParseUUIDPipe) propertyId: string) {
    return this.calendar.history(propertyId);
  }

  @Post('rules/preview')
  @RequirePermissions('rateplans.manage')
  @ApiOperation({ summary: 'Before / after prices of a new rule; nothing is saved' })
  preview(@Query('propertyId', ParseUUIDPipe) propertyId: string, @Body() dto: PriceRuleDto) {
    return this.calendar.preview(propertyId, dto);
  }

  @Post('rules/:id/preview')
  @RequirePermissions('rateplans.manage')
  @ApiOperation({ summary: 'Before / after prices of a changed rule; nothing is saved' })
  previewChange(@Param('id', ParseUUIDPipe) id: string, @Query('propertyId', ParseUUIDPipe) propertyId: string, @Body() dto: PriceRuleDto) {
    return this.calendar.preview(propertyId, dto, id);
  }

  @Post('rules')
  @RequirePermissions('rateplans.manage')
  @ApiOperation({ summary: 'Add a season, holiday or promo' })
  create(@Query('propertyId', ParseUUIDPipe) propertyId: string, @Body() dto: PriceRuleDto, @AuditActorCtx() actor: AuditActor) {
    return this.calendar.create(propertyId, dto, actor);
  }

  @Patch('rules/:id')
  @RequirePermissions('rateplans.manage')
  @ApiOperation({ summary: 'Change or switch off a price rule' })
  update(@Param('id', ParseUUIDPipe) id: string, @Query('propertyId', ParseUUIDPipe) propertyId: string, @Body() dto: UpdatePriceRuleDto, @AuditActorCtx() actor: AuditActor) {
    return this.calendar.update(propertyId, id, dto as any, actor);
  }

  @Put('bounds/:roomTypeId')
  @RequirePermissions('rateplans.manage')
  @ApiOperation({ summary: 'Set the min / max nightly price of a room type' })
  bounds(@Param('roomTypeId', ParseUUIDPipe) roomTypeId: string, @Query('propertyId', ParseUUIDPipe) propertyId: string, @Body() dto: PriceBoundsDto, @AuditActorCtx() actor: AuditActor) {
    return this.calendar.setBounds(propertyId, roomTypeId, dto, actor);
  }
}
