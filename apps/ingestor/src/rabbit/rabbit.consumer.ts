import { Injectable, Logger } from '@nestjs/common'
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import amqp from 'amqplib'
import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib'
import type { Env } from '../config/env.ts'

// Обменники и очереди объявляет тот, кто их читает: иначе издатель отправляет
// в пустоту, а очередь появляется только после первого запуска консьюмера.
const COMMANDS = 'thesis.commands'
const RETRY = 'thesis.retry'
const PARKED = 'thesis.parked'

// Пауза перед повторной попыткой. Транзиентная ошибка — это недоступная база
// или брокер, и десяти секунд обычно хватает, чтобы они вернулись.
const RETRY_MS = 10_000
// Больше трёх попыток — значит дело не в случайности. Дальше в «отстойник»:
// там сообщение ждёт человека, а не крутится по кругу, съедая брокер.
const MAX_ATTEMPTS = 3

// Ошибка, которую повторять бессмысленно: «неизвестный тип операции» не
// исправится от второй попытки. Правило проекта требует различать её от
// ошибки провайдера или сети — здесь это различие и живёт.
export class PermanentFailure extends Error {}

export type Handler = (payload: unknown) => Promise<void>

@Injectable()
export class RabbitConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(RabbitConsumer.name)
  private connection: ChannelModel | null = null
  private channel: Channel | null = null
  private readonly handlers = new Map<string, Handler>()

  constructor(private readonly config: ConfigService<Env, true>) {}

  // Порядок хуков Nest от нас не зависит: RabbitConsumer — зависимость модуля
  // импорта, поэтому его onApplicationBootstrap выполняется **раньше**, и
  // обработчик, зарегистрированный в хуке потребителя, приходит к уже
  // поднятому каналу. Проверено на живом брокере: очередь не слушалась вовсе.
  // Поэтому подписка работает в любом порядке — сразу, если канал готов, и
  // при подъёме, если нет.
  on(queue: string, handler: Handler): void {
    this.handlers.set(queue, handler)
    if (this.channel) void this.subscribe(this.channel, queue, handler)
  }

  private async subscribe(channel: Channel, queue: string, handler: Handler): Promise<void> {
    await this.bind(channel, queue)
    await channel.consume(queue, (message) => {
      if (message) void this.handle(channel, queue, message, handler)
    })
    this.log.log(`слушаю ${queue}`)
  }

  async onApplicationBootstrap(): Promise<void> {
    // В тестах наружу не ходим вовсе: правило проекта — живых внешних вызовов
    // из тестов нет. Отдельного модуля мало: e2e-тесты собирают AppModule
    // целиком, и без этой проверки они требуют поднятых брокеров (в CI их нет,
    // а локально они есть — отсюда тесты, зелёные только на моей машине).
    if (this.config.get('NODE_ENV', { infer: true }) === 'test') return
    const url = this.config.get('RABBITMQ_URL', { infer: true })
    const connection = await amqp.connect(url)
    const channel = await connection.createChannel()
    this.connection = connection
    this.channel = channel

    await channel.assertExchange(COMMANDS, 'direct', { durable: true })
    await channel.assertExchange(RETRY, 'direct', { durable: true })
    await channel.assertExchange(PARKED, 'direct', { durable: true })

    // Одно сообщение за раз: разбор отчёта занимает секунды и ест память, а
    // честная очередь лучше десяти одновременных разборов.
    await channel.prefetch(1)

    for (const [queue, handler] of this.handlers) {
      await this.subscribe(channel, queue, handler)
    }
  }

  // Топология: основная очередь → при отказе в retry с TTL → обратно в
  // основную. Счётчик попыток берётся из x-death, который RabbitMQ ведёт сам.
  private async bind(channel: Channel, queue: string): Promise<void> {
    await channel.assertQueue(queue, {
      durable: true,
      deadLetterExchange: RETRY,
      deadLetterRoutingKey: queue,
    })
    await channel.bindQueue(queue, COMMANDS, queue)

    await channel.assertQueue(`${queue}.retry`, {
      durable: true,
      messageTtl: RETRY_MS,
      // Отлежавшись, сообщение возвращается в основную очередь само.
      deadLetterExchange: COMMANDS,
      deadLetterRoutingKey: queue,
    })
    await channel.bindQueue(`${queue}.retry`, RETRY, queue)

    // Отстойник: без TTL и без возврата. Отсюда сообщение забирает человек.
    await channel.assertQueue(`${queue}.parked`, { durable: true })
    await channel.bindQueue(`${queue}.parked`, PARKED, queue)
  }

  private attempts(message: ConsumeMessage): number {
    const deaths = message.properties.headers?.['x-death']
    if (!Array.isArray(deaths)) return 0
    const first = deaths[0] as { count?: number } | undefined
    return typeof first?.count === 'number' ? first.count : 0
  }

  private async handle(
    channel: Channel,
    queue: string,
    message: ConsumeMessage,
    handler: Handler,
  ): Promise<void> {
    try {
      await handler(JSON.parse(message.content.toString()))
      // ack только после успешной записи в базу: правило проекта требует
      // именно этого порядка, иначе падение теряет задание.
      channel.ack(message)
      return
    } catch (error) {
      const permanent = error instanceof PermanentFailure
      const attempts = this.attempts(message)

      if (permanent || attempts >= MAX_ATTEMPTS) {
        // В отстойник с причиной: сообщение без объяснения бесполезно тому,
        // кто будет разбираться.
        channel.publish(PARKED, queue, message.content, {
          persistent: true,
          headers: {
            ...message.properties.headers,
            'x-failure': String(error),
            'x-attempts': attempts + 1,
          },
        })
        channel.ack(message)
        this.log.warn(
          `${queue}: ${permanent ? 'отказ навсегда' : `сдались после ${attempts + 1} попыток`} — ${String(error)}`,
        )
        return
      }

      // nack без requeue отправляет сообщение в dead-letter, то есть в
      // очередь ожидания: немедленный requeue дал бы горячий цикл.
      channel.nack(message, false, false)
      this.log.warn(
        `${queue}: попытка ${attempts + 1} не удалась, повтор через 10 с — ${String(error)}`,
      )
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.channel?.close()
    await this.connection?.close()
    this.channel = null
    this.connection = null
  }
}
