import { Injectable, Logger } from '@nestjs/common'
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { KafkaJS } from '@confluentinc/kafka-javascript'
import { KEYS_TOPIC } from '@thesis/contracts'
import type { ExchangeKeyChecked } from '@thesis/contracts'
import { ensureTopics } from '../prices/kafka.topics.ts'
import { PrismaService } from '../db/prisma.service.ts'
import type { Env } from '../config/env.ts'

const { Kafka } = KafkaJS

// Своя группа: дедупликация у каждой группы своя, и статус ключей не должен
// зависеть от того, докуда дочитал консьюмер цен.
const GROUP = 'api.keys.v1'
const CONSUMER = GROUP

@Injectable()
export class KeysConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(KeysConsumer.name)
  private consumer: KafkaJS.Consumer | null = null

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // В тестах наружу не ходим вовсе: e2e собирает AppModule целиком, и без
    // этой проверки тесты требуют поднятой Kafka.
    if (this.config.get('NODE_ENV', { infer: true }) === 'test') return
    const brokers = this.config.get('KAFKA_BROKERS', { infer: true })
    await ensureTopics(brokers, [KEYS_TOPIC])
    const consumer = new Kafka().consumer({
      'bootstrap.servers': brokers,
      'group.id': GROUP,
      'enable.auto.commit': false,
      'auto.offset.reset': 'earliest',
    })
    this.consumer = consumer

    await consumer.connect()
    await consumer.subscribe({ topics: [KEYS_TOPIC] })
    this.log.log(`kafka ${brokers}, группа ${GROUP}`)

    void consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        const eventId = message.headers?.['event-id']?.toString()
        const value = message.value?.toString()
        if (!eventId || !value) {
          this.log.warn('сообщение без идентификатора события или без тела — пропущено')
        } else {
          await this.apply(eventId, JSON.parse(value) as ExchangeKeyChecked)
        }

        await consumer.commitOffsets([
          { topic, partition, offset: (Number(message.offset) + 1).toString() },
        ])
      },
    })
  }

  // Публичный, потому что его зовёт тест: брокер в тестах не поднимается, а
  // проверять надо именно эту транзакцию.
  //
  // Под withUser: у api_keys есть RLS, и писать её без сессии пользователя
  // нельзя — отсюда userId в событии.
  async apply(eventId: string, event: ExchangeKeyChecked): Promise<void> {
    await this.prisma.withUser(event.userId, async (tx) => {
      const claimed = await tx.$queryRaw<{ id: string }[]>`
        insert into processed_messages (consumer, event_id)
        values (${CONSUMER}, ${eventId}::uuid)
        on conflict (consumer, event_id) do nothing
        returning id
      `
      if (claimed.length === 0) return

      // Повторная проверка того же ключа перезаписывает статус целиком:
      // «отклонён» после «активен» — нормальная история, если права ключа
      // поменяли в кабинете биржи.
      await tx.$executeRaw`
        update api_keys
           set status = ${event.status},
               permissions = ${JSON.stringify(event.scopes)}::jsonb,
               error = ${event.reason ?? null},
               verified_at = ${event.checkedAt}::timestamptz
         where account_id = ${event.accountId}::uuid
           and exchange = ${event.exchange}
      `
    })
    this.log.log(`ключ ${event.exchange} счёта ${event.accountId}: ${event.status}`)
  }

  async onApplicationShutdown(): Promise<void> {
    await this.consumer?.disconnect()
    this.consumer = null
  }
}
