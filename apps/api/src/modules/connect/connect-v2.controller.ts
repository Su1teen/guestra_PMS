import {Controller,Get,Post,Body,Query,Param,ParseUUIDPipe,UseGuards,Req,BadRequestException} from '@nestjs/common';
import {ApiTags,ApiSecurity,ApiOperation,ApiQuery} from '@nestjs/swagger';
import {Public} from '../auth/public.decorator';
import {ApiKeyGuard} from '../auth/api-key.guard';
import {ConnectScopeGuard} from '../auth/connect-scope.guard';
import {ConnectV2Guard} from './connect-v2.guard';
import {ConnectV2Service} from './connect-v2.service';
import {ServiceCapability} from './service-capability.decorator';
import {ConnectQuoteDto,ConnectBookV2Dto,ConnectMutationV2Dto,ConnectAmendV2Dto,ConnectServiceChangeV2Dto,ConnectServiceStatusV2Dto,ConnectRequestV2Dto,ConnectFixtureDto} from './dto/connect-v2.dto';
import {ConnectSandboxService} from './connect-sandbox.service';
import {AgentServiceAvailabilityDto,AgentServiceBookDto} from './dto/agent-service.dto';
import {AgentSearchDto} from './dto/agent-search.dto';
@ApiTags('Guestra integration v2') @ApiSecurity('api-key') @Controller('connect/v2') @Public()
@UseGuards(ApiKeyGuard,ConnectScopeGuard,ConnectV2Guard)
export class ConnectV2Controller {
  constructor(private readonly service:ConnectV2Service,private readonly sandbox:ConnectSandboxService) {}
  @Post('sandbox/fixtures') @ServiceCapability('sandbox.setup') @ApiOperation({summary:'Create isolated, expiring scenario fixtures; production is forbidden'})
  fixture(@Body() dto:ConnectFixtureDto) {return this.sandbox.setup(dto);}
  @Get('sandbox/fixtures/:key') @ServiceCapability('sandbox.setup') @ApiOperation({summary:'Verify an existing isolated fixture'})
  fixtureRead(@Query('propertyId',ParseUUIDPipe) p:string,@Param('key') key:string,@Query('customerId') customer:string) {return this.sandbox.read(p,key,customer);}
  @Post('sandbox/fixtures/:key/retire') @ServiceCapability('sandbox.setup') @ApiOperation({summary:'Release only fixture inventory and retain test audit history'})
  fixtureRetire(@Body() dto:ConnectFixtureDto,@Param('key') key:string) {return this.sandbox.retire(dto.propertyId,key,dto.customerId);}
  @Post('sandbox/fixtures/:key/simulate-payment') @ServiceCapability('sandbox.setup') @ApiOperation({summary:'Confirm a simulated payment without writing to the payments ledger'})
  fixturePayment(@Body() dto:ConnectFixtureDto,@Param('key') key:string) {return this.sandbox.simulatePayment(dto.propertyId,key,dto.customerId);}
  @Get('capabilities') @ServiceCapability('integration.read') @ApiOperation({summary:'Attest environment, property and tenant for v2'})
  capabilities(@Query('propertyId',ParseUUIDPipe) propertyId:string,@Req() request:any) {return this.service.capabilities(propertyId,request.connect.credentialId);}
  @Post('quote') @ServiceCapability('integration.read') @ApiOperation({summary:'Issue a signed canonical accepted-price quote'})
  quote(@Body() dto:ConnectQuoteDto) {return this.service.quote(dto);}
  @Post('book') @ServiceCapability('integration.write') @ApiOperation({summary:'Book exactly once against an accepted price'})
  book(@Body() dto:ConnectBookV2Dto) {return this.service.book(dto);}
  @Post('search') @ServiceCapability('integration.read') @ApiOperation({summary:'Property scoped canonical inventory and rates'})
  search(@Body() dto:AgentSearchDto) {return this.service.search(dto);}
  @Post('reservations/:id/cancel') @ServiceCapability('integration.write') @ApiOperation({summary:'Cancel atomically with policy settlement and an immutable receipt'})
  cancel(@Param('id',ParseUUIDPipe) id:string,@Body() dto:ConnectMutationV2Dto) {return this.service.mutateReservation(id,dto,'cancel');}
  @Post('reservations/:id/amend') @ServiceCapability('integration.write') @ApiOperation({summary:'Amend accepted dates, inventory and folio in one local transaction'})
  amend(@Param('id',ParseUUIDPipe) id:string,@Body() dto:ConnectAmendV2Dto) {return this.service.mutateReservation(id,dto,'amend');}
  @Get('services') @ServiceCapability('integration.read') @ApiOperation({summary:'Authoritative bookable services'})
  services(@Query('propertyId',ParseUUIDPipe) p:string) {return this.service.serviceOptions(p);}
  @Post('services/availability') @ServiceCapability('integration.read') @ApiOperation({summary:'Authoritative service price and resource availability'})
  serviceAvailability(@Body() dto:AgentServiceAvailabilityDto) {return this.service.serviceAvailability(dto);}
  @Post('services/book') @ServiceCapability('integration.write') @ApiOperation({summary:'Book a service with accepted amount and CRM origin'})
  serviceBook(@Body() dto:AgentServiceBookDto) {return this.service.serviceBook(dto);}
  @Post('services/:id/reschedule') @ServiceCapability('integration.write') @ApiOperation({summary:'Move an owned service against its revision'})
  serviceChange(@Param('id',ParseUUIDPipe) id:string,@Body() dto:ConnectServiceChangeV2Dto) {return this.service.serviceChange(id,dto);}
  @Post('services/:id/cancel') @ServiceCapability('integration.write') @ApiOperation({summary:'Cancel an owned service without claiming a refund'})
  serviceCancel(@Param('id',ParseUUIDPipe) id:string,@Body() dto:ConnectServiceStatusV2Dto) {return this.service.serviceCancel(id,dto);}
  @Post('guest-requests') @ServiceCapability('integration.write') @ApiOperation({summary:'Create a guest scoped operational request exactly once'})
  request(@Body() dto:ConnectRequestV2Dto) {return this.service.guestRequest(dto);}
  @Get('entities/:type/:id') @ServiceCapability('integration.read') @ApiOperation({summary:'Guest scoped authoritative operational read-back'})
  snapshot(@Query('propertyId',ParseUUIDPipe) p:string,@Param('type') t:string,@Param('id',ParseUUIDPipe) id:string,@Query('customerId') customer:string) {
    if(!customer)throw new BadRequestException('CUSTOMER_REQUIRED');return this.service.snapshot(p,t,id,customer);
  }
  @Get('operations/:key') @ServiceCapability('integration.read') @ApiOperation({summary:'Recover a committed operation after a lost response'})
  operation(@Query('propertyId',ParseUUIDPipe) p:string,@Param('key') key:string,@Query('customerId') customer:string) {
    if(!customer)throw new BadRequestException('CUSTOMER_REQUIRED');return this.service.operation(p,key,customer);
  }
  @Get('events') @ServiceCapability('events.read') @ApiOperation({summary:'Read immutable committed events with a durable cursor'})
  events(@Query('propertyId',ParseUUIDPipe) p:string,@Query('after') after?:string,@Query('limit') limit?:string) {
    const count=Number(limit??100);if(!Number.isInteger(count)||count<1||count>200)throw new BadRequestException('INVALID_LIMIT');
    return this.service.events(p,Number(after??0),count);
  }
}
