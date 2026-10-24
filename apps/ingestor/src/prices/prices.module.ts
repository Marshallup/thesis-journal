import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module.ts'
import { OutboundModule } from '../outbound/outbound.module.ts'
import { OutboxModule } from '../outbox/outbox.module.ts'
import { BybitTickerService } from '../connectors/bybit/ticker.service.ts'
import { MoexClient } from './moex.client.ts'
import { CbrClient } from './cbr.client.ts'
import { CryptoPricesService } from './crypto.service.ts'
import { PricesService } from './prices.service.ts'

// Без планировщика — он в отдельном модуле. Разделение сохранено при переезде
// из api: интеграционный тест поднимает этот модуль и физически не может уйти
// в живой ISS, потому что в нём некому дёрнуть опрос.
@Module({
  imports: [DbModule, OutboundModule, OutboxModule],
  providers: [MoexClient, PricesService, CryptoPricesService, CbrClient, BybitTickerService],
  exports: [PricesService, CryptoPricesService, BybitTickerService],
})
export class PricesModule {}
