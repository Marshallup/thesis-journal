import { Module } from '@nestjs/common'
import { RabbitConsumer } from './rabbit.consumer.ts'

@Module({
  providers: [RabbitConsumer],
  exports: [RabbitConsumer],
})
export class RabbitModule {}
