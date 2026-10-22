import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Interval } from '@nestjs/schedule'
import type { Env } from '../config/env.ts'
import { KafkaProducer } from '../kafka/kafka.producer.ts'
import { OutboxRepository } from './outbox.repository.ts'

// Две секунды: задержка доставки цены в проекцию, которую человек не заметит,
// а брокер не почувствует.
const TICK_MS = 2000
// Партия. Первый прогон с историей даёт тысячи событий, и выгребать их надо
// частями: одна гигантская отправка держит транзакцию и память.
const BATCH = 500

@Injectable()
export class OutboxRelay {
  private readonly log = new Logger(OutboxRelay.name)
  // Цикл не должен наезжать на себя: отправка пачки бывает дольше тика.
  private running = false

  constructor(
    private readonly outbox: OutboxRepository,
    private readonly producer: KafkaProducer,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Interval(TICK_MS)
  async pump(): Promise<void> {
    // В тестах продюсер не подключён, и отправлять некуда: тест зовёт pump()
    // напрямую с подменённым продюсером, а по таймеру — не ходит.
    if (this.config.get('NODE_ENV', { infer: true }) === 'test') return
    if (this.running) return
    this.running = true
    try {
      for (;;) {
        const events = await this.outbox.pending(BATCH)
        if (events.length === 0) break

        await this.producer.send(
          events.map((event) => ({
            topic: event.topic,
            key: event.key,
            value: JSON.stringify(event.payload),
            // По нему потребитель узнаёт дубль. В теле сообщения ему не место:
            // это свойство доставки, а не факта о цене.
            headers: { 'event-id': event.id },
          })),
        )
        // Только после подтверждённой отправки: упасть здесь значит отправить
        // партию второй раз, а не потерять её.
        await this.outbox.markPublished(events.map((event) => event.id))
        this.log.log(`отправлено событий: ${events.length}`)

        if (events.length < BATCH) break
      }
    } catch (error) {
      // Событие осталось неотправленным и уйдёт следующим тиком. Молчать здесь
      // нельзя: иначе проекция отстаёт, а причина не видна.
      this.log.warn(`outbox не опорожнён: ${String(error)}`)
    } finally {
      this.running = false
    }
  }
}
