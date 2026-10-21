import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module.ts'
import { DecisionsModule } from '../decisions/decisions.module.ts'
import { InstrumentsModule } from '../instruments/instruments.module.ts'
import { TradesModule } from '../trades/trades.module.ts'
import { ApplyImportService } from './apply-import.service.ts'
import { ImportsController } from './imports.controller.ts'
import { RawImportService } from './raw-import.service.ts'

@Module({
  imports: [DbModule, TradesModule, InstrumentsModule, DecisionsModule],
  controllers: [ImportsController],
  providers: [RawImportService, ApplyImportService],
  exports: [RawImportService, ApplyImportService],
})
export class ImportsModule {}
