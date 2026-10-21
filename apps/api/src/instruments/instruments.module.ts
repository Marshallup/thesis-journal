import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module.ts'
import { InstrumentsController } from './instruments.controller.ts'

@Module({ imports: [DbModule], controllers: [InstrumentsController] })
export class InstrumentsModule {}
