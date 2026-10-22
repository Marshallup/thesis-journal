import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module.ts'
import { OutboxRepository } from './outbox.repository.ts'

// Только запись событий: сюда ходят сервисы, которые пишут данные. Отправкой
// занимается OutboxRelayModule, и тесты его не поднимают — поэтому в них не
// бывает ни подключения к брокеру, ни отправленных сообщений.
@Module({
  imports: [DbModule],
  providers: [OutboxRepository],
  exports: [OutboxRepository],
})
export class OutboxModule {}
