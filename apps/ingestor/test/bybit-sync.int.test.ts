import { randomBytes, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigService } from '@nestjs/config'
import { IMPORT_PARSED_TOPIC } from '@thesis/contracts'
import { MASTER_KEY_BYTES, seal } from '@thesis/contracts/crypto'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { BybitSyncService } from '../src/connectors/bybit/sync.service.ts'
import { ImportsService } from '../src/imports/imports.service.ts'
import { KeyVault } from '../src/keys/vault.ts'
import { OutboxRepository } from '../src/outbox/outbox.repository.ts'
import { PermanentFailure } from '../src/rabbit/rabbit.consumer.ts'
import { PrismaService } from '../src/db/prisma.service.ts'
import {
  badParams,
  emptyPage,
  firstPage,
  loopingPage,
  rateLimited,
  secondPage,
} from './fixtures/bybit-executions.ts'
import type { Env } from '../src/config/env.ts'
import type { ExternalCall } from '../src/outbound/external-call.ts'
import type { ImportParsed } from '@thesis/contracts'
import type { RabbitConsumer } from '../src/rabbit/rabbit.consumer.ts'
import { withTestDb } from './setup-db.ts'

let db: Awaited<ReturnType<typeof withTestDb>>
let prisma: PrismaService
let sync: BybitSyncService
let imports: ImportsService

const masterKey = randomBytes(MASTER_KEY_BYTES)
const keyFile = join(tmpdir(), `thesis-sync-master-${randomUUID()}.key`)
const realFetch = globalThis.fetch

const consumer = { on: () => {} } as unknown as RabbitConsumer
// Ограничитель проверяется своими тестами на настоящем Redis; здесь он только
// мешал бы ждать.
const calls = { run: (_provider: string, fn: () => Promise<unknown>) => fn() } as ExternalCall

// Биржа отвечает по курсору: без него первая страница, с ним — вторая.
// Запоминаем адреса, чтобы проверить окна и продолжение с курсора.
function answerPages(pages: unknown[]): { urls: string[] } {
  const urls: string[] = []
  let call = 0
  globalThis.fetch = vi.fn(async (url: unknown) => {
    urls.push(String(url))
    const body = pages[Math.min(call, pages.length - 1)]
    call += 1
    return new Response(JSON.stringify(body), { status: 200 })
  }) as unknown as typeof fetch
  return { urls }
}

async function seedKey(accountId: string): Promise<void> {
  const box = seal('секрет-биржи', masterKey)
  await prisma.exchangeKey.create({
    data: {
      accountId,
      exchange: 'bybit',
      apiKeyPublic: 'bybitPublicPart7f3a',
      // Копия в свой ArrayBuffer: Prisma для bytea ждёт именно такой.
      ciphertext: new Uint8Array(box.ciphertext),
      nonce: new Uint8Array(box.nonce),
      tag: new Uint8Array(box.tag),
    },
  })
}

async function published(): Promise<ImportParsed[]> {
  const events = await prisma.outboxEvent.findMany({
    where: { topic: IMPORT_PARSED_TOPIC },
    orderBy: { id: 'asc' },
  })
  return events.map((event) => event.payload as unknown as ImportParsed)
}

function command(accountId: string, from: string) {
  return { accountId, userId: randomUUID(), exchange: 'bybit' as const, from }
}

beforeAll(async () => {
  db = await withTestDb()
  process.env.INGESTOR_DATABASE_URL = db.url
  writeFileSync(keyFile, masterKey.toString('hex'), { mode: 0o600 })
  prisma = new PrismaService()
  await prisma.$connect()
  const config = { get: () => keyFile } as unknown as ConfigService<Env, true>
  sync = new BybitSyncService(
    prisma,
    new OutboxRepository(prisma),
    new KeyVault(prisma, config),
    calls,
    consumer,
  )
  imports = new ImportsService(prisma, new OutboxRepository(prisma), consumer)
})

beforeEach(async () => {
  await prisma.outboxEvent.deleteMany()
  await prisma.syncCursor.deleteMany()
  await prisma.exchangeKey.deleteMany()
})

afterEach(() => {
  globalThis.fetch = realFetch
})

afterAll(async () => {
  await prisma.$disconnect()
  await db.stop()
})

// Страница — сто строк, дальше курсор. Без склейки синхронизация теряет всё,
// кроме первой сотни, и это не видно: сделки есть, просто меньше.
it('склеивает страницы по курсору и публикует операции одним событием', async () => {
  const accountId = randomUUID()
  await seedKey(accountId)
  const { urls } = answerPages([firstPage, secondPage])

  const result = await sync.run(command(accountId, new Date(Date.now() - 86_400_000).toISOString()))

  // Четыре строки, из них одна — фондирование: в сделки идут три.
  expect(result.operations).toBe(3)
  const [event] = await published()
  expect(event?.operations.map((operation) => operation.externalId)).toEqual([
    'exec-1',
    'exec-2',
    'exec-3',
  ])
  expect(event?.source).toBe('bybit')
  // Комиссия покупки приведена к валюте сделки: 0.00001 BTC × 64000 = 0.64 USDT.
  expect(event?.operations[0]?.fee).toBe('0.64')
  expect(event?.fileHash).toHaveLength(64)
  // Второй запрос ушёл с курсором первой страницы.
  expect(urls[1]).toContain('cursor=page-2')
})

// Не всё в этом списке — сделка: фондирование и ликвидации в лоты не ложатся.
it('фондирование не превращается в сделку', async () => {
  const accountId = randomUUID()
  await seedKey(accountId)
  answerPages([firstPage, secondPage])

  await sync.run(command(accountId, new Date(Date.now() - 86_400_000).toISOString()))

  const [event] = await published()
  expect(event?.operations.every((operation) => operation.kind === 'trade')).toBe(true)
  expect(event?.operations.map((operation) => operation.externalId)).not.toContain('exec-4')
})

// Курсор двигается по окнам: обрыв на середине двух лет не должен заставлять
// перечитывать два года.
it('запоминает, докуда синхронизировал', async () => {
  const accountId = randomUUID()
  await seedKey(accountId)
  answerPages([emptyPage])
  const startedAt = Date.now()

  await sync.run(command(accountId, new Date(startedAt - 86_400_000).toISOString()))

  const cursor = await prisma.syncCursor.findFirstOrThrow({ where: { accountId } })
  expect(cursor.stream).toBe('bybit:executions:spot')
  // Правая граница последнего окна — «сейчас», с точностью до прогона теста.
  expect(cursor.syncedUntil.getTime()).toBeGreaterThanOrEqual(startedAt - 1000)
})

// Повторная синхронизация без новых сделок не должна публиковать пустые
// события: иначе в импортах появятся строки, за которыми ничего нет.
it('пустое окно не публикует событие', async () => {
  const accountId = randomUUID()
  await seedKey(accountId)
  answerPages([emptyPage])

  const result = await sync.run(command(accountId, new Date(Date.now() - 86_400_000).toISOString()))

  expect(result.operations).toBe(0)
  expect(await published()).toEqual([])
})

// То же окно второй раз даёт тот же хеш: по нему api узнает, что нового нет.
// Хеш считается от идентификаторов, поэтому порядок страниц на него не влияет.
it('одно и то же окно даёт один и тот же хеш', async () => {
  const accountId = randomUUID()
  await seedKey(accountId)
  const from = new Date(Date.now() - 86_400_000).toISOString()

  answerPages([firstPage, secondPage])
  await sync.run(command(accountId, from))
  answerPages([firstPage, secondPage])
  await sync.run(command(accountId, from))

  const events = await published()
  expect(events).toHaveLength(2)
  expect(events[0]?.fileHash).toBe(events[1]?.fileHash)
  // Идентификаторы импортов разные: строку создаёт api, и по хешу она отобьёт
  // вторую.
  expect(events[0]?.importId).not.toBe(events[1]?.importId)
})

// Повторный курсор — неисправность на стороне биржи. Крутиться по нему вечно
// хуже, чем отказать: вечный цикл держит очередь и ест лимит.
it('повторный курсор отбивается, а не крутится вечно', async () => {
  const accountId = randomUUID()
  await seedKey(accountId)
  answerPages([loopingPage])

  await expect(
    sync.run(command(accountId, new Date(Date.now() - 86_400_000).toISOString())),
  ).rejects.toThrow(/тот же курсор/)
})

// Синхронизация без ключа — отказ навсегда: ключ появится не от повторной
// попытки, а когда его сохранят.
it('без сохранённого ключа — отказ навсегда', async () => {
  answerPages([emptyPage])

  await expect(
    sync.run(command(randomUUID(), new Date(Date.now() - 86_400_000).toISOString())),
  ).rejects.toThrow(PermanentFailure)
})

// Та самая ошибка, на которой синхронизация не пошла вовсе: граница двух лет у
// биржи строгая. Запрос без даты должен укладываться внутрь неё.
it('первое окно просит историю внутри двух лет, а не ровно за два года', async () => {
  const accountId = randomUUID()
  await seedKey(accountId)
  const { urls } = answerPages([emptyPage])
  const twoYearsAgo = Date.now() - 2 * 365 * 24 * 60 * 60 * 1000

  // Без `from` и без курсора: именно так выглядит первая синхронизация.
  await sync.run({ accountId, userId: randomUUID(), exchange: 'bybit' })

  const start = Number(new URL(urls[0] ?? '').searchParams.get('startTime'))
  expect(start).toBeGreaterThan(twoYearsAgo)
})

// Отказ по параметрам не лечится повтором, и молчать о нём нельзя: экран
// смотрит на импорты, значит и отказ приезжает импортом.
it('ошибка в параметрах становится отказом навсегда и видна импортом', async () => {
  const accountId = randomUUID()
  await seedKey(accountId)
  answerPages([badParams])

  await expect(
    sync.run(command(accountId, new Date(Date.now() - 86_400_000).toISOString())),
  ).rejects.toThrow(PermanentFailure)

  const [event] = await published()
  expect(event?.error).toContain('10001')
  expect(event?.operations).toEqual([])
})

// Лимит провайдера — не наша ошибка: она уходит в повтор, и события об отказе
// быть не должно, иначе экран показал бы отказ там, где его ещё нет.
it('лимит биржи уходит в повтор, а не в отказ', async () => {
  const accountId = randomUUID()
  await seedKey(accountId)
  answerPages([rateLimited])

  const failure = sync.run(command(accountId, new Date(Date.now() - 86_400_000).toISOString()))
  await expect(failure).rejects.toThrow(/10006/)
  await expect(failure).rejects.not.toBeInstanceOf(PermanentFailure)

  expect(await published()).toEqual([])
})

// «Разобрать заново» должно работать для синхронизации так же, как для отчёта:
// иначе отложенная продажа, дождавшаяся своей покупки, не применится никогда —
// повторная синхронизация отдаёт тот же хеш и пропускается.
it('операции остаются сырьём, и повторный разбор их перечитывает', async () => {
  const accountId = randomUUID()
  await seedKey(accountId)
  answerPages([firstPage, secondPage])
  await sync.run(command(accountId, new Date(Date.now() - 86_400_000).toISOString()))
  const [first] = await published()

  const raw = await prisma.rawImport.findUniqueOrThrow({
    where: { importId: first!.importId },
  })
  expect(raw.source).toBe('bybit')
  expect(JSON.parse(Buffer.from(raw.payload).toString('utf8'))).toHaveLength(3)

  // Повторный разбор идёт без байтов в команде и без обращения к бирже.
  await prisma.outboxEvent.deleteMany()
  const { urls } = answerPages([emptyPage])
  await imports.parse({
    importId: first!.importId,
    accountId,
    userId: first!.userId,
    source: 'bybit',
    fileHash: raw.fileHash,
  })

  // К бирже повторный разбор не ходит вовсе: сырьё уже лежит здесь.
  expect(urls).toHaveLength(0)
  const [again] = await published()
  expect(again?.operations.map((operation) => operation.externalId)).toEqual([
    'exec-1',
    'exec-2',
    'exec-3',
  ])
  // Хеша в событии повторного разбора нет: строка импорта уже существует, и
  // создавать её второй раз не надо — иначе консьюмер счёл бы это дублем.
  expect(again?.fileHash).toBeUndefined()
  expect(again?.error).toBeUndefined()
})

// Источник, которого мы не умеем разбирать, по-прежнему отказ навсегда: иначе
// команда крутилась бы в повторах из-за опечатки в источнике.
it('незнакомый источник отказывает навсегда', async () => {
  const accountId = randomUUID()

  await expect(
    imports.parse({
      importId: randomUUID(),
      accountId,
      userId: randomUUID(),
      source: 'kraken',
      fileHash: 'нет',
      payloadBase64: Buffer.from('[]').toString('base64'),
    }),
  ).rejects.toThrow(PermanentFailure)
})
