import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module.ts'
import { OutboxModule } from '../outbox/outbox.module.ts'
import { RabbitModule } from '../rabbit/rabbit.module.ts'
import { KeysService } from './keys.service.ts'

// Ключи от биржи хранит воркер: расшифровать их должен тот, кто ходит на
// биржу. Тесты этот модуль не поднимают — брокера в них нет.
@Module({
  imports: [DbModule, OutboxModule, RabbitModule],
  providers: [KeysService],
})
export class KeysModule {}
