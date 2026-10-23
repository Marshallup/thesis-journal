import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module.ts'
import { RabbitModule } from '../rabbit/rabbit.module.ts'
import { SyncController } from './sync.controller.ts'
import { SyncService } from './sync.service.ts'

@Module({
  imports: [DbModule, RabbitModule],
  controllers: [SyncController],
  providers: [SyncService],
})
export class SyncModule {}
