import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module.ts'
import { KeysConsumer } from './keys.consumer.ts'

// Отдельный модуль по той же причине, что у консьюмера цен: тесты его не
// поднимают, и подключений к брокеру в них не бывает по построению.
@Module({
  imports: [DbModule],
  providers: [KeysConsumer],
})
export class KeysConsumerModule {}
