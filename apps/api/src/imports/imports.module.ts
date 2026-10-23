import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module.ts'
import { DecisionsModule } from '../decisions/decisions.module.ts'
import { InstrumentsModule } from '../instruments/instruments.module.ts'
import { RabbitModule } from '../rabbit/rabbit.module.ts'
import { TradesModule } from '../trades/trades.module.ts'
import { ApplyImportService } from './apply-import.service.ts'
import { ImportsController } from './imports.controller.ts'
import { ImportsService } from './imports.service.ts'

@Module({
  imports: [DbModule, TradesModule, InstrumentsModule, DecisionsModule, RabbitModule],
  controllers: [ImportsController],
  providers: [ImportsService, ApplyImportService],
  exports: [ImportsService, ApplyImportService],
})
export class ImportsModule {}
