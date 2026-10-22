import { Injectable, Logger } from '@nestjs/common'
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { KafkaJS } from '@confluentinc/kafka-javascript'
import type { Env } from '../config/env.ts'

// Клиент Confluent — обёртка над librdkafka, и namespace KafkaJS даёт
// совместимый с kafkajs интерфейс. Импорт проверен под обычным Node ESM, а не
// только в тестах: пакет CJS, и у таких бывает, что именованный импорт
// работает в сборщике и падает в проде.
const { Kafka } = KafkaJS

export type OutgoingMessage = { topic: string; key: string; value: string }

@Injectable()
export class KafkaProducer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(KafkaProducer.name)
  private producer: KafkaJS.Producer | null = null

  constructor(private readonly config: ConfigService<Env, true>) {}

  async onApplicationBootstrap(): Promise<void> {
    const brokers = this.config.get('KAFKA_BROKERS', { infer: true })
    this.producer = new Kafka().producer({
      'bootstrap.servers': brokers,
      // Идемпотентный продюсер: повторная отправка после сетевого сбоя не
      // создаёт дубля в партиции и, что важнее, не переставляет сообщения.
      'enable.idempotence': true,
      // Порядок внутри партиции важнее задержки: ключ сообщения выбран как
      // раз для него.
      'linger.ms': 5,
    })
    await this.producer.connect()
    this.log.log(`kafka ${brokers}`)
  }

  // Отправка пачкой: relay читает события партией, и один сетевой поход на
  // партию дешевле, чем поход на событие.
  async send(messages: OutgoingMessage[]): Promise<void> {
    const producer = this.producer
    if (!producer) throw new Error('продюсер не подключён')
    if (messages.length === 0) return

    await producer.sendBatch({
      topicMessages: Object.entries(
        messages.reduce<Record<string, { key: string; value: string }[]>>((byTopic, message) => {
          const batch = byTopic[message.topic] ?? []
          batch.push({ key: message.key, value: message.value })
          byTopic[message.topic] = batch
          return byTopic
        }, {}),
      ).map(([topic, batch]) => ({ topic, messages: batch })),
    })
  }

  // disconnect флашит буфер: без него выход по SIGTERM теряет то, что ещё не
  // ушло по сети, и событие останется в outbox до следующего запуска.
  async onApplicationShutdown(): Promise<void> {
    await this.producer?.disconnect()
    this.producer = null
  }
}
