import { Injectable, Logger } from '@nestjs/common'
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import amqp from 'amqplib'
import type { Channel, ChannelModel } from 'amqplib'
import type { Env } from '../config/env.ts'

// Имя обменника — часть контракта с воркером. Очереди здесь не объявляются:
// их объявляет тот, кто читает, иначе api заводил бы очередь, из которой
// некому брать.
const COMMANDS = 'thesis.commands'

@Injectable()
export class RabbitPublisher implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(RabbitPublisher.name)
  private connection: ChannelModel | null = null
  private channel: Channel | null = null

  constructor(private readonly config: ConfigService<Env, true>) {}

  async onApplicationBootstrap(): Promise<void> {
    // В тестах наружу не ходим вовсе: правило проекта — живых внешних вызовов
    // из тестов нет. Отдельного модуля мало: e2e-тесты собирают AppModule
    // целиком, и без этой проверки они требуют поднятых брокеров (в CI их нет,
    // а локально они есть — отсюда тесты, зелёные только на моей машине).
    if (this.config.get('NODE_ENV', { infer: true }) === 'test') return
    const url = this.config.get('RABBITMQ_URL', { infer: true })
    this.connection = await amqp.connect(url)
    this.channel = await this.connection.createChannel()
    // Обменник объявляется и здесь: publish в несуществующий обменник закрывает
    // канал, и следующая команда уходит в тишину.
    await this.channel.assertExchange(COMMANDS, 'direct', { durable: true })
    this.log.log('rabbitmq подключён')
  }

  // Команда адресована одному исполнителю, поэтому direct-обменник и ключ,
  // равный имени очереди.
  send(queue: string, command: unknown): void {
    const channel = this.channel
    if (!channel) throw new Error('rabbitmq не подключён')

    channel.publish(COMMANDS, queue, Buffer.from(JSON.stringify(command)), {
      // Иначе команда живёт только в памяти брокера и исчезает при его
      // перезапуске вместе с загруженным отчётом.
      persistent: true,
      contentType: 'application/json',
    })
  }

  async onApplicationShutdown(): Promise<void> {
    await this.channel?.close()
    await this.connection?.close()
    this.channel = null
    this.connection = null
  }
}
