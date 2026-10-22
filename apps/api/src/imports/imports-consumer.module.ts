import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module.ts'
import { ImportsModule } from './imports.module.ts'
import { ImportsConsumer } from './imports.consumer.ts'

// Единственное место, где api слушает события разбора. Отдельный модуль, как и
// у цен: тесты его не поднимают, брокера в них нет.
@Module({
  imports: [DbModule, ImportsModule],
  providers: [ImportsConsumer],
})
export class ImportsConsumerModule {}
