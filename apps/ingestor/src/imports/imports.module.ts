import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module.ts'
import { OutboundModule } from '../outbound/outbound.module.ts'
import { OutboxModule } from '../outbox/outbox.module.ts'
import { RabbitModule } from '../rabbit/rabbit.module.ts'
import { ImportsService } from './imports.service.ts'

// Этот модуль и есть «воркер разбирает отчёты»: слушает команду, пишет сырьё,
// публикует событие. Тесты его не поднимают — брокера в них нет.
@Module({
  imports: [DbModule, OutboundModule, OutboxModule, RabbitModule],
  providers: [ImportsService],
})
export class ImportsModule {}
