import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module.ts'
import { InstrumentsController } from './instruments.controller.ts'
import { InstrumentsService } from './instruments.service.ts'

@Module({
  imports: [DbModule],
  controllers: [InstrumentsController],
  providers: [InstrumentsService],
  exports: [InstrumentsService],
})
export class InstrumentsModule {}
