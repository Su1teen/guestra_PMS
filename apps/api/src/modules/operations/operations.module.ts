import { Module } from '@nestjs/common';
import { OperationsController } from './operations.controller';
import { OperationsService } from './operations.service';
import { RoomModule } from '../room/room.module';

@Module({ imports: [RoomModule], controllers: [OperationsController], providers: [OperationsService], exports: [OperationsService] })
export class OperationsModule {}
