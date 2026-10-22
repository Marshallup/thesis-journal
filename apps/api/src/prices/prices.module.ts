import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module.ts'
import { PricesController } from './prices.controller.ts'
import { PricesService } from './prices.service.ts'

// Только чтение проекции цен: опрос биржи уехал в ingestor (задача 19c).
// Наружу из api не уходит ни одного запроса к бирже — больше нечем.
@Module({
  imports: [DbModule],
  controllers: [PricesController],
  providers: [PricesService],
  exports: [PricesService],
})
export class PricesModule {}
