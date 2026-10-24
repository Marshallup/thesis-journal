import { Injectable, Logger } from '@nestjs/common'
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { KafkaJS } from '@confluentinc/kafka-javascript'
import { IMPORT_PARSED_TOPIC } from '@thesis/contracts'
import type { ImportParsed } from '@thesis/contracts'
import { ensureTopics } from '../prices/kafka.topics.ts'
import { PrismaService } from '../db/prisma.service.ts'
import { ApplyImportService, ImportAlreadyRunning } from './apply-import.service.ts'
import type { Env } from '../config/env.ts'

const { Kafka } = KafkaJS

const GROUP = 'api.imports.v1'

@Injectable()
export class ImportsConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(ImportsConsumer.name)
  private consumer: KafkaJS.Consumer | null = null

  constructor(
    private readonly prisma: PrismaService,
    private readonly apply: ApplyImportService,
    private readonly config: ConfigService<Env, true>,
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
    await ensureTopics(brokers, [IMPORT_PARSED_TOPIC])
    const consumer = new Kafka().consumer({
      'bootstrap.servers': brokers,
      'group.id': GROUP,
      'enable.auto.commit': false,
      'auto.offset.reset': 'earliest',
    })
    this.consumer = consumer

    await consumer.connect()
    await consumer.subscribe({ topics: [IMPORT_PARSED_TOPIC] })
    this.log.log(`kafka ${brokers}, группа ${GROUP}`)

    void consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        const eventId = message.headers?.['event-id']?.toString()
        const value = message.value?.toString()
        if (eventId && value) {
          await this.handle(eventId, JSON.parse(value) as ImportParsed)
        } else {
          this.log.warn('событие разбора без идентификатора или без тела — пропущено')
        }
        await consumer.commitOffsets([
          { topic, partition, offset: (Number(message.offset) + 1).toString() },
        ])
      },
    })
  }

  // Применение не в одной транзакции с отметкой, и это осознанно: применение
  // отчёта — это десятки сделок, лотов и позиций под advisory-локом, и держать
  // его в транзакции с дедупликацией значит удлинять лок на время разбора
  // ошибок. Поэтому отметка ставится первой и отдельно: повторная доставка не
  // применит отчёт второй раз, а если процесс умрёт между отметкой и
  // применением, спасёт идемпотентность самих операций по
  // (account_id, provider, external_id).
  // Публичный, потому что его зовёт тест: брокер в тестах не поднимается, а
  // проверять надо именно эту последовательность — отметка, строка импорта,
  // применение.
  async handle(eventId: string, event: ImportParsed): Promise<void> {
    const claimed = await this.prisma.$queryRaw<{ id: string }[]>`
      insert into processed_messages (consumer, event_id)
      values (${GROUP}, ${eventId}::uuid)
      on conflict (consumer, event_id) do nothing
      returning id
    `
    if (claimed.length === 0) {
      this.log.log(`импорт ${event.importId}: событие уже обработано`)
      return
    }

    // Строку импорта для синхронизации создаёт консьюмер: `file_hash` известен
    // только после ответа биржи, и до него создавать её нечему. Для файла
    // строка уже есть — её завела загрузка.
    if (event.fileHash && !(await this.ensureImport(event))) {
      this.log.log(`синхронизация ${event.accountId}: биржа отдала то же, нового нет`)
      return
    }

    if (event.error) {
      // Разбор отказал — в базе это видно как failed с причиной, иначе экран
      // вечно пишет «разбираем».
      await this.prisma.withUser(event.userId, (tx) =>
        tx.import.update({
          where: { id: event.importId },
          data: { status: 'failed', error: event.error ?? null },
        }),
      )
      this.log.warn(`импорт ${event.importId}: разбор отказал — ${event.error}`)
      return
    }

    try {
      const result = await this.apply.apply(
        event.userId,
        event.importId,
        event.operations,
        event.skipped,
      )
      this.log.log(
        `импорт ${event.importId}: создано ${result.created}, пропущено ${result.skipped}, отложено ${result.deferred.length}`,
      )
    } catch (error) {
      // ApplyImportService сам пометил импорт failed; гонка за advisory-лок —
      // не отказ, а «другой отчёт того же счёта применяется прямо сейчас».
      if (error instanceof ImportAlreadyRunning) {
        this.log.warn(`импорт ${event.importId}: счёт занят другим импортом`)
        return
      }
      this.log.warn(`импорт ${event.importId}: применение отказало — ${String(error)}`)
    }
  }

  // true — строку создали мы, и операции надо применить. false — строка с таким
  // хешем уже есть, то есть это та же выборка биржи во второй раз.
  //
  // ON CONFLICT, а не «посмотреть и вставить»: две синхронизации одного счёта
  // могут идти одновременно, и между проверкой и вставкой влезет вторая.
  private async ensureImport(event: ImportParsed): Promise<boolean> {
    return this.prisma.withUser(event.userId, async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        insert into imports (id, account_id, source, file_hash, status)
        values (
          ${event.importId}::uuid, ${event.accountId}::uuid,
          ${event.source}, ${event.fileHash}, 'parsing'
        )
        on conflict (account_id, file_hash) do nothing
        returning id
      `
      return rows.length > 0
    })
  }

  async onApplicationShutdown(): Promise<void> {
    await this.consumer?.disconnect()
    this.consumer = null
  }
}
