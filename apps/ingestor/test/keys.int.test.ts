import { randomBytes, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigService } from '@nestjs/config'
import { KEYS_TOPIC } from '@thesis/contracts'
import { MASTER_KEY_BYTES, seal, unseal } from '@thesis/contracts/crypto'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { KeysService } from '../src/keys/keys.service.ts'
import { KeyVault } from '../src/keys/vault.ts'
import type { ExternalCall } from '../src/outbound/external-call.ts'
import { OutboxRepository } from '../src/outbox/outbox.repository.ts'
import { PermanentFailure } from '../src/rabbit/rabbit.consumer.ts'
import { PrismaService } from '../src/db/prisma.service.ts'
import { busyExchange, invalidKey, readOnlyKey, tradingKey } from './fixtures/bybit-api-key.ts'
import type { Env } from '../src/config/env.ts'
import type { ExchangeKeyChecked, ExchangeKeySave } from '@thesis/contracts'
import type { RabbitConsumer } from '../src/rabbit/rabbit.consumer.ts'
import { withTestDb } from './setup-db.ts'

let db: Awaited<ReturnType<typeof withTestDb>>
let prisma: PrismaService
let keys: KeysService

const masterKey = randomBytes(MASTER_KEY_BYTES)
const keyFile = join(tmpdir(), `thesis-worker-master-${randomUUID()}.key`)
const realFetch = globalThis.fetch

// Консьюмер подменён: брокера в тестах нет, а проверяется обработчик — то, что
// он пишет, что публикует и чем отказывает.
const consumer = { on: () => {} } as unknown as RabbitConsumer

function configWith(path: string | undefined): ConfigService<Env, true> {
  return { get: () => path } as unknown as ConfigService<Env, true>
}

// Ограничитель и размыкатель здесь ни при чём: они проверяются своими
// тестами на настоящем Redis, а тут нужен сам обработчик команды.
const calls = { run: (_provider: string, fn: () => Promise<unknown>) => fn() } as ExternalCall

function serviceWith(path: string | undefined): KeysService {
  const vault = new KeyVault(prisma, configWith(path))
  return new KeysService(prisma, new OutboxRepository(prisma), vault, calls, consumer)
}

// К бирже из тестов не ходим: правило проекта. Отвечаем записанной формой
// ответа и запоминаем, сколько раз спросили.
function answerWith(body: unknown): { calls: number } {
  const counter = { calls: 0 }
  globalThis.fetch = vi.fn(async () => {
    counter.calls += 1
    return new Response(JSON.stringify(body), { status: 200 })
  }) as unknown as typeof fetch
  return counter
}

function command(secret: string, accountId: string): ExchangeKeySave {
  const box = seal(secret, masterKey)
  return {
    accountId,
    userId: randomUUID(),
    exchange: 'bybit',
    apiKeyPublic: 'bybitPublicPart7f3a',
    ciphertextBase64: box.ciphertext.toString('base64'),
    nonceBase64: box.nonce.toString('base64'),
    tagBase64: box.tag.toString('base64'),
  }
}

async function published(): Promise<ExchangeKeyChecked[]> {
  const events = await prisma.outboxEvent.findMany({
    where: { topic: KEYS_TOPIC },
    orderBy: { id: 'asc' },
  })
  return events.map((event) => event.payload as unknown as ExchangeKeyChecked)
}

beforeAll(async () => {
  db = await withTestDb()
  process.env.INGESTOR_DATABASE_URL = db.url
  writeFileSync(keyFile, masterKey.toString('hex'), { mode: 0o600 })
  prisma = new PrismaService()
  await prisma.$connect()
  keys = serviceWith(keyFile)
})

beforeEach(async () => {
  await prisma.outboxEvent.deleteMany()
})

afterEach(() => {
  globalThis.fetch = realFetch
})

afterAll(async () => {
  await prisma.$disconnect()
  await db.stop()
})

// Шифротекст доезжает целым: воркер расшифровывает его тем же мастер-ключом,
// которым зашифровал api, и только поэтому может подписать запрос к бирже.
it('ключ только на чтение сохраняется и расшифровывается обратно', async () => {
  const accountId = randomUUID()
  answerWith(readOnlyKey)

  await keys.save(command('секрет-биржи', accountId))

  const stored = await prisma.exchangeKey.findUniqueOrThrow({
    where: { exchange_key_per_account: { accountId, exchange: 'bybit' } },
  })
  expect(unseal(stored, masterKey)).toBe('секрет-биржи')
  expect(await published()).toMatchObject([{ accountId, status: 'active' }])
})

// Обещание README проверяется кодом: ключ с правом торговать не просто
// помечается отказом, он **не попадает на диск вовсе**.
it('ключ с правом торговать не сохраняется, а отклоняется с причиной', async () => {
  const accountId = randomUUID()
  answerWith(tradingKey)

  await keys.save(command('секрет-биржи', accountId))

  expect(await prisma.exchangeKey.count({ where: { accountId } })).toBe(0)
  const [event] = await published()
  expect(event?.status).toBe('rejected')
  expect(event?.reason).toContain('Read-only')
  expect(event?.scopes).toContain('Spot:SpotTrade')
})

// Повторная команда — замена ключа, а не второй ключ: на бирже у счёта один
// действующий ключ, и в базе должно быть так же.
it('повторная команда обновляет ключ, а не добавляет второй', async () => {
  const accountId = randomUUID()
  answerWith(readOnlyKey)
  await keys.save(command('первый', accountId))
  await keys.save(command('второй', accountId))

  const rows = await prisma.exchangeKey.findMany({ where: { accountId } })
  expect(rows).toHaveLength(1)
  expect(unseal(rows[0]!, masterKey)).toBe('второй')
})

// Подменённый шифротекст означает подменённое сообщение. На биржу с таким
// ключом не ходим вовсе: сначала целостность, потом сеть.
it('подменённый шифротекст отбивается до запроса к бирже', async () => {
  const accountId = randomUUID()
  const tampered = command('секрет', accountId)
  const bytes = Buffer.from(tampered.ciphertextBase64, 'base64')
  bytes[0] = (bytes[0] ?? 0) ^ 0xff
  tampered.ciphertextBase64 = bytes.toString('base64')
  const counter = answerWith(readOnlyKey)

  await expect(keys.save(tampered)).rejects.toThrow(PermanentFailure)

  expect(counter.calls).toBe(0)
  expect(await prisma.exchangeKey.count({ where: { accountId } })).toBe(0)
  expect(await published()).toEqual([])
})

// Мастер-ключ у api и воркера должен быть одним файлом. Если воркер читает
// другой, узнать об этом надо на записи ключа, а не при первой синхронизации.
it('чужой мастер-ключ у воркера — отказ навсегда', async () => {
  const other = join(tmpdir(), `thesis-worker-other-${randomUUID()}.key`)
  writeFileSync(other, randomBytes(MASTER_KEY_BYTES).toString('hex'), { mode: 0o600 })
  const accountId = randomUUID()
  answerWith(readOnlyKey)

  await expect(serviceWith(other).save(command('секрет', accountId))).rejects.toThrow(
    PermanentFailure,
  )
  expect(await prisma.exchangeKey.count({ where: { accountId } })).toBe(0)
})

// Команда пришла, а файла с ключом нет: это ошибка настройки, и три попытки её
// не исправят.
it('без MASTER_KEY_FILE команда отбивается с внятной причиной', async () => {
  answerWith(readOnlyKey)

  await expect(serviceWith(undefined).save(command('секрет', randomUUID()))).rejects.toThrow(
    /MASTER_KEY_FILE/,
  )
})

// Занятая биржа — не отказ навсегда: такое уходит в повтор, а не в отстойник,
// и ничего не записывает. Вердикта по ключу здесь тоже нет: мы ещё не знаем
// его прав.
it('ошибка провайдера оставляет ключ незаписанным и уходит в повтор', async () => {
  const accountId = randomUUID()
  answerWith(busyExchange)

  const failure = keys.save(command('секрет', accountId))
  await expect(failure).rejects.toThrow(/10006/)
  await expect(failure).rejects.not.toBeInstanceOf(PermanentFailure)

  expect(await prisma.exchangeKey.count({ where: { accountId } })).toBe(0)
  expect(await published()).toEqual([])
})

// Биржа может не принять ключ вовсе — опечатка, истёкший срок, белый список
// адресов. Без вердикта экран навсегда остался бы на «ждёт проверки».
it('ключ, который не приняла биржа, становится отклонённым с её причиной', async () => {
  const accountId = randomUUID()
  answerWith(invalidKey)

  await keys.save(command('секрет', accountId))

  const [event] = await published()
  expect(event?.status).toBe('rejected')
  expect(event?.reason).toContain('10003')
  expect(await prisma.exchangeKey.count({ where: { accountId } })).toBe(0)
})
