import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module.ts'
import { DecisionsModule } from '../decisions/decisions.module.ts'
import { TradesController } from './trades.controller.ts'
import { TradesService } from './trades.service.ts'

@Module({
  imports: [DbModule, DecisionsModule],
  controllers: [TradesController],
  providers: [TradesService],
  exports: [TradesService],
})
export class TradesModule {}
