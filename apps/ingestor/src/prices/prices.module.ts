import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module.ts'
import { OutboxModule } from '../outbox/outbox.module.ts'
import { MoexClient } from './moex.client.ts'
import { PricesService } from './prices.service.ts'

// Без планировщика — он в отдельном модуле. Разделение сохранено при переезде
// из api: интеграционный тест поднимает этот модуль и физически не может уйти
// в живой ISS, потому что в нём некому дёрнуть опрос.
@Module({
  imports: [DbModule, OutboxModule],
  providers: [MoexClient, PricesService],
  exports: [PricesService],
})
export class PricesModule {}
