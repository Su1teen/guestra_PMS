import {Controller,Get,Post,Query,Param,ParseUUIDPipe} from '@nestjs/common';
import {ApiTags,ApiOperation} from '@nestjs/swagger';
import {RequirePermissions} from '../auth/permissions.decorator';
import {CurrentUser,type AuthUser} from '../auth/current-user.decorator';
import {ConnectInboxService} from './connect-inbox.service';
@ApiTags('Guest Inbox') @Controller('guest-inbox')
export class ConnectInboxController {
  constructor(private readonly inbox:ConnectInboxService) {}
  @Get() @RequirePermissions('communications.manage') @ApiOperation({summary:'Read authoritative CRM conversations for this property'})
  list(@Query('propertyId',ParseUUIDPipe) p:string,@CurrentUser() u:AuthUser) {return this.inbox.list(p,u);}
  @Get(':id') @RequirePermissions('communications.manage') @ApiOperation({summary:'Guest safe conversation and authorized PMS operational context'})
  detail(@Query('propertyId',ParseUUIDPipe) p:string,@Param('id') id:string,@CurrentUser() u:AuthUser) {return this.inbox.detail(p,id,u);}
  @Post(':id/takeover') @RequirePermissions('communications.manage') @ApiOperation({summary:'Persist human ownership in CRM with an authenticated PMS staff reference'})
  takeover(@Query('propertyId',ParseUUIDPipe) p:string,@Param('id') id:string,@CurrentUser() u:AuthUser) {return this.inbox.takeover(p,id,u);}
}
