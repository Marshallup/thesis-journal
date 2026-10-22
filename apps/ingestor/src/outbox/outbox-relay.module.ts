import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'
import { KafkaProducer } from '../kafka/kafka.producer.ts'
import { OutboxModule } from './outbox.module.ts'
import { OutboxRelay } from './outbox.relay.ts'

// Единственное место, где процесс подключается к Kafka как издатель.
@Module({
  imports: [OutboxModule, ScheduleModule.forRoot()],
  providers: [KafkaProducer, OutboxRelay],
})
export class OutboxRelayModule {}
