import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module.ts'
import { ImportsController } from './imports.controller.ts'
import { RawImportService } from './raw-import.service.ts'

@Module({
  imports: [DbModule],
  controllers: [ImportsController],
  providers: [RawImportService],
  exports: [RawImportService],
})
export class ImportsModule {}
