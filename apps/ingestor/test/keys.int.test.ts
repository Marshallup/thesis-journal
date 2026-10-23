import { randomBytes, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigService } from '@nestjs/config'
import { MASTER_KEY_BYTES, seal, unseal } from '@thesis/contracts/crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { PrismaService } from '../src/db/prisma.service.ts'
import { KeysService } from '../src/keys/keys.service.ts'
import { PermanentFailure } from '../src/rabbit/rabbit.consumer.ts'
import type { Env } from '../src/config/env.ts'
import type { ExchangeKeySave } from '@thesis/contracts'
import type { RabbitConsumer } from '../src/rabbit/rabbit.consumer.ts'
import { withTestDb } from './setup-db.ts'

let db: Awaited<ReturnType<typeof withTestDb>>
let prisma: PrismaService
let keys: KeysService

const masterKey = randomBytes(MASTER_KEY_BYTES)
const keyFile = join(tmpdir(), `thesis-worker-master-${randomUUID()}.key`)

// Консьюмер подменён: брокера в тестах нет, а проверяется обработчик — то, что
// он пишет и чем отказывает.
const consumer = { on: () => {} } as unknown as RabbitConsumer

function configWith(path: string | undefined): ConfigService<Env, true> {
  return { get: () => path } as unknown as ConfigService<Env, true>
}

function command(secret: string, accountId: string): ExchangeKeySave {
  const box = seal(secret, masterKey)
  return {
    accountId,
    exchange: 'bybit',
    apiKeyPublic: 'bybitPublicPart',
    ciphertextBase64: box.ciphertext.toString('base64'),
    nonceBase64: box.nonce.toString('base64'),
    tagBase64: box.tag.toString('base64'),
  }
}

beforeAll(async () => {
  db = await withTestDb()
  process.env.INGESTOR_DATABASE_URL = db.url
  writeFileSync(keyFile, masterKey.toString('hex'), { mode: 0o600 })
  prisma = new PrismaService()
  await prisma.$connect()
  keys = new KeysService(prisma, consumer, configWith(keyFile))
})

afterAll(async () => {
  await prisma.$disconnect()
  await db.stop()
})

// Шифротекст доезжает целым: воркер расшифровывает его тем же мастер-ключом,
// которым зашифровал api. Это и есть проверка, что по брокеру едет не мусор.
it('ключ сохраняется шифротекстом и расшифровывается обратно', async () => {
  const accountId = randomUUID()
  await keys.save(command('секрет-биржи', accountId))

  const stored = await prisma.exchangeKey.findUniqueOrThrow({
    where: { exchange_key_per_account: { accountId, exchange: 'bybit' } },
  })
  expect(unseal(stored, masterKey)).toBe('секрет-биржи')
  expect(stored.apiKeyPublic).toBe('bybitPublicPart')
})

// Повторная команда — замена ключа, а не второй ключ: на бирже у счёта один
// действующий ключ, и в базе должно быть так же.
it('повторная команда обновляет ключ, а не добавляет второй', async () => {
  const accountId = randomUUID()
  await keys.save(command('первый', accountId))
  await keys.save(command('второй', accountId))

  const rows = await prisma.exchangeKey.findMany({ where: { accountId } })
  expect(rows).toHaveLength(1)
  expect(unseal(rows[0]!, masterKey)).toBe('второй')
})

// Подменённый тег означает подменённое сообщение. Повторять такое бессмысленно:
// отказ навсегда, в отстойник, и ничего не записано.
it('подменённый шифротекст отбивается и в базу не попадает', async () => {
  const accountId = randomUUID()
  const tampered = command('секрет', accountId)
  const bytes = Buffer.from(tampered.ciphertextBase64, 'base64')
  bytes[0] = (bytes[0] ?? 0) ^ 0xff
  tampered.ciphertextBase64 = bytes.toString('base64')

  await expect(keys.save(tampered)).rejects.toThrow(PermanentFailure)
  expect(await prisma.exchangeKey.count({ where: { accountId } })).toBe(0)
})

// Мастер-ключ у api и воркера должен быть одним файлом. Если воркер читает
// другой, узнать об этом надо на записи ключа, а не при первой синхронизации.
it('чужой мастер-ключ у воркера — отказ навсегда', async () => {
  const other = join(tmpdir(), `thesis-worker-other-${randomUUID()}.key`)
  writeFileSync(other, randomBytes(MASTER_KEY_BYTES).toString('hex'), { mode: 0o600 })
  const stranger = new KeysService(prisma, consumer, configWith(other))

  const accountId = randomUUID()
  await expect(stranger.save(command('секрет', accountId))).rejects.toThrow(PermanentFailure)
  expect(await prisma.exchangeKey.count({ where: { accountId } })).toBe(0)
})

// Команда пришла, а файла с ключом нет: это ошибка настройки, и три попытки
// её не исправят.
it('без MASTER_KEY_FILE команда отбивается с внятной причиной', async () => {
  const unconfigured = new KeysService(prisma, consumer, configWith(undefined))

  await expect(unconfigured.save(command('секрет', randomUUID()))).rejects.toThrow(
    /MASTER_KEY_FILE/,
  )
})
