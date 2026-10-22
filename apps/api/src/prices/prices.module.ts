import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module.ts'
import { MoexClient } from './moex.client.ts'
import { PricesController } from './prices.controller.ts'
import { PricesService } from './prices.service.ts'

// Без планировщика: он живёт в PricesSchedulerModule, и тесты его не поднимают
// вовсе — значит наружу из них не уйдёт ни один запрос.
@Module({
  imports: [DbModule],
  controllers: [PricesController],
  providers: [MoexClient, PricesService],
  exports: [PricesService],
})
export class PricesModule {}
