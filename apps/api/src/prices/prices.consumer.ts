import { Injectable, Logger } from '@nestjs/common'
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { KafkaJS } from '@confluentinc/kafka-javascript'
import { PRICES_TOPIC } from '@thesis/contracts'
import type { PriceQuoted } from '@thesis/contracts'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { ensureTopics } from './kafka.topics.ts'
import { PRICE_APPLIED } from './price-applied.event.ts'
import { PrismaService } from '../db/prisma.service.ts'
import type { Env } from '../config/env.ts'

const { Kafka } = KafkaJS

// Имя группы — часть контракта: сменишь его, и консьюмер прочитает топик с
// начала. Версия в имени для того, чтобы это было осознанным действием.
const GROUP = 'api.prices.v1'
// Под этим именем консьюмер отмечается в processed_messages. Совпадает с
// группой не случайно: дедупликация у каждой группы своя.
const CONSUMER = GROUP

@Injectable()
export class PricesConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(PricesConsumer.name)
  private consumer: KafkaJS.Consumer | null = null

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly events: EventEmitter2,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // В тестах наружу не ходим вовсе: правило проекта — живых внешних вызовов
    // из тестов нет. Отдельного модуля мало: e2e-тесты собирают AppModule
    // целиком, и без этой проверки они требуют поднятых брокеров (в CI их нет,
    // а локально они есть — отсюда тесты, зелёные только на моей машине).
    if (this.config.get('NODE_ENV', { infer: true }) === 'test') return
    const brokers = this.config.get('KAFKA_BROKERS', { infer: true })
    // До подписки: иначе консьюмер уходит в «Unknown topic» и не
    // возвращается, когда топик наконец появляется.
    await ensureTopics(brokers, [PRICES_TOPIC])
    const consumer = new Kafka().consumer({
      'bootstrap.servers': brokers,
      'group.id': GROUP,
      // Автокоммит выключен: офсет коммитится только после записи в базу,
      // иначе падение между коммитом и записью теряет событие навсегда.
      'enable.auto.commit': false,
      // Новая группа читает топик с начала: проекция должна собраться целиком,
      // а не с момента первого запуска.
      'auto.offset.reset': 'earliest',
    })
    this.consumer = consumer

    await consumer.connect()
    await consumer.subscribe({ topics: [PRICES_TOPIC] })
    this.log.log(`kafka ${brokers}, группа ${GROUP}`)

    // Без await: run() — это цикл, и ждать его значит не дать приложению
    // подняться.
    void consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        const eventId = message.headers?.['event-id']?.toString()
        const value = message.value?.toString()
        if (!eventId || !value) {
          this.log.warn('сообщение без идентификатора события или без тела — пропущено')
        } else {
          await this.apply(eventId, JSON.parse(value) as PriceQuoted)
        }

        // Kafka ждёт «офсет следующего сообщения», а не «последний
        // обработанный»: без +1 последнее сообщение прочитается заново.
        await consumer.commitOffsets([
          { topic, partition, offset: (Number(message.offset) + 1).toString() },
        ])
      },
    })
  }

  // Обработка и отметка — в одной транзакции. Отметка идёт первой и через
  // ON CONFLICT DO NOTHING: если строка уже есть, значит событие обработано, и
  // второй раз цену писать не нужно. Проверка «сначала select» здесь была бы
  // гонкой между двумя экземплярами api.
  //
  // Публичный, потому что его зовёт тест: брокер в тестах не поднимается, а
  // проверять надо именно эту транзакцию — в ней вся идемпотентность.
  //
  // Возвращает, применилось ли событие: повторная доставка не должна будить
  // шлюз сокетов — цена от неё не изменилась.
  async apply(eventId: string, event: PriceQuoted): Promise<boolean> {
    const applied = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.$queryRaw<{ id: string }[]>`
        insert into processed_messages (consumer, event_id)
        values (${CONSUMER}, ${eventId}::uuid)
        on conflict (consumer, event_id) do nothing
        returning id
      `
      if (claimed.length === 0) return false

      // Проекция. ON CONFLICT по тому же ключу, что у источника: опоздавшее
      // или повторное событие ничего не затирает.
      await tx.$executeRaw`
        insert into instrument_prices (instrument_id, source, price, quoted_at)
        values (
          ${event.instrumentId}::uuid,
          ${event.source},
          ${event.price}::numeric,
          ${event.quotedAt}::timestamptz
        )
        on conflict (instrument_id, source, quoted_at) do nothing
      `
      return true
    })

    // После транзакции, а не внутри: слушатель увидит цену в базе, а не
    // догонит ещё не закрытую транзакцию.
    if (applied) this.events.emit(PRICE_APPLIED, event)
    return applied
  }

  async onApplicationShutdown(): Promise<void> {
    await this.consumer?.disconnect()
    this.consumer = null
  }
}
