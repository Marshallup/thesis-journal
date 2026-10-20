import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module.ts'
import { TradesController } from './trades.controller.ts'
import { TradesService } from './trades.service.ts'

@Module({
  imports: [DbModule],
  controllers: [TradesController],
  providers: [TradesService],
  exports: [TradesService],
})
export class TradesModule {}
