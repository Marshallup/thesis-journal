import { Module } from '@nestjs/common'
import { DbModule } from '../../db/db.module.ts'
import { KeysModule } from '../../keys/keys.module.ts'
import { OutboundModule } from '../../outbound/outbound.module.ts'
import { OutboxModule } from '../../outbox/outbox.module.ts'
import { RabbitModule } from '../../rabbit/rabbit.module.ts'
import { BybitSyncService } from './sync.service.ts'

// Синхронизация сделок: слушает команду, ходит на биржу через общий
// ограничитель, отдаёт операции тем же событием, что и разбор отчёта.
@Module({
  imports: [DbModule, KeysModule, OutboundModule, OutboxModule, RabbitModule],
  providers: [BybitSyncService],
})
export class BybitModule {}
