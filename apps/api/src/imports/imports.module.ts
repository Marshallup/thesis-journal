import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module.ts'
import { DecisionsModule } from '../decisions/decisions.module.ts'
import { InstrumentsModule } from '../instruments/instruments.module.ts'
import { TradesModule } from '../trades/trades.module.ts'
import { ApplyImportService } from './apply-import.service.ts'
import { ImportsController } from './imports.controller.ts'
import { ImportsService } from './imports.service.ts'
import { RabbitPublisher } from './rabbit.publisher.ts'

@Module({
  imports: [DbModule, TradesModule, InstrumentsModule, DecisionsModule],
  controllers: [ImportsController],
  providers: [RabbitPublisher, ImportsService, ApplyImportService],
  exports: [ImportsService, ApplyImportService],
})
export class ImportsModule {}
