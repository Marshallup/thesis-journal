import { Module } from '@nestjs/common'
import { RabbitPublisher } from './rabbit.publisher.ts'

// Издатель общий на процесс: соединение и канал к брокеру не бесплатны, и
// второй экземпляр ради второй фичи означал бы второй канал к той же очереди.
@Module({
  providers: [RabbitPublisher],
  exports: [RabbitPublisher],
})
export class RabbitModule {}
