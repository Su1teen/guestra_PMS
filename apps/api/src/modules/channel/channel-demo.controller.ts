import { BadRequestException, Body, Controller, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { channelConnections } from '@telivityhaip/database';
import { IsDateString, IsIn, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { RequirePermissions } from '../auth/permissions.decorator';
import { AvailabilityService } from '../reservation/availability.service';
import { ChannelService } from './channel.service';
import { InboundReservationService } from './inbound-reservation.service';

const channels = ['yandex', 'ostrovok', 'bronevik'] as const;

export class SimulatedRevisionDto {
  @IsUUID()
  bookingId!: string;

  @IsUUID()
  revisionId!: string;

  @IsIn(['new', 'modified', 'cancelled'])
  status!: 'new' | 'modified' | 'cancelled';

  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  arrivalDate!: string;

  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  departureDate!: string;

  @IsString()
  @MaxLength(100)
  roomCode!: string;

  @IsString()
  @MaxLength(100)
  rateCode!: string;
}

@ApiTags('Channel Manager — SIMULATED')
@Controller('channels/demo')
@RequirePermissions('channels.manage')
export class ChannelDemoController {
  constructor(
    private readonly config: ConfigService,
    private readonly channelsService: ChannelService,
    private readonly inbound: InboundReservationService,
    private readonly availability: AvailabilityService,
  ) {}

  @Post(':channel/revisions')
  @ApiOperation({ summary: 'Apply a SIMULATED channel revision to the local demo property' })
  @ApiQuery({ name: 'propertyId', required: true })
  async apply(
    @Param('channel') channel: typeof channels[number],
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Body() dto: SimulatedRevisionDto,
  ) {
    if (this.config.get('NODE_ENV') === 'production' ||
        this.config.get('CHANNEL_DEMO_PROPERTY_ID') !== propertyId || !channels.includes(channel)) {
      throw new NotFoundException();
    }
    if (dto.departureDate <= dto.arrivalDate) throw new BadRequestException('Invalid stay dates');
    const code = `SIMULATED:${channel}`;
    const active: Array<typeof channelConnections.$inferSelect> = await this.channelsService.getActiveConnections(propertyId);
    if (active.some((conn) => conn.adapterType !== 'mock')) throw new BadRequestException('Demo property has a live connection');
    const connection = active.find((conn) => conn.channelCode === code);
    if (!connection) throw new NotFoundException('SIMULATED channel connection is missing');
    const room = connection.roomTypeMapping?.find((entry) => entry.channelRoomCode === dto.roomCode);
    if (!room) throw new BadRequestException('SIMULATED room mapping is missing');

    const result = await this.inbound.processSimulatedRevision(connection.id, propertyId, {
      externalConfirmation: dto.bookingId, externalRevisionId: dto.revisionId,
      channelCode: code, channelBookingDate: new Date(), status: dto.status,
      guestFirstName: 'SIMULATED', guestLastName: channel,
      channelRoomCode: dto.roomCode, channelRateCode: dto.rateCode,
      arrivalDate: dto.arrivalDate, departureDate: dto.departureDate,
      adults: 1, children: 0, totalAmount: 0, currencyCode: 'KZT',
    });
    const nights = await this.availability.searchAvailability(propertyId, dto.arrivalDate, dto.departureDate, room.roomTypeId);
    return {
      mode: 'SIMULATED',
      channel,
      bookingId: result.bookingId,
      reservationId: result.reservationId,
      availability: nights.map(({ date, available }) => ({ date, available })),
    };
  }
}
