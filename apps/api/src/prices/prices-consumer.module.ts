import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module.ts'
import { PricesConsumer } from './prices.consumer.ts'

// Единственное место, где api подключается к Kafka. Отдельный модуль по той же
// причине, что у планировщика в ingestor: тесты его не поднимают, и
// подключений к брокеру в них не бывает по построению.
@Module({
  imports: [DbModule],
  providers: [PricesConsumer],
})
export class PricesConsumerModule {}
