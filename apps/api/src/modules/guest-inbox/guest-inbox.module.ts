import { Module } from '@nestjs/common';
import { CrmInboxClient } from './crm-inbox.client';
import { GuestChannelLogListener } from './guest-channel-log.listener';

/** CRM conversation access for PMS (inbox, chats, document confirmations) and the email/SMS copy into guest chats. */
@Module({ providers: [CrmInboxClient, GuestChannelLogListener], exports: [CrmInboxClient] })
export class GuestInboxModule {}
