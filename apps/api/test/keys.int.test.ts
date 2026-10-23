import { randomBytes, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ForbiddenException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { MASTER_KEY_BYTES, unseal } from '@thesis/contracts/crypto'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { PrismaService } from '../src/db/prisma.service.ts'
import { KeysService } from '../src/keys/keys.service.ts'
import type { Env } from '../src/config/env.ts'
import type { RabbitPublisher } from '../src/rabbit/rabbit.publisher.ts'
import type { ExchangeKeySave } from '@thesis/contracts'
import { withTestDb } from './setup-db.ts'

let db: Awaited<ReturnType<typeof withTestDb>>
let prisma: PrismaService

// Мастер-ключ лежит файлом и в тестах тоже: читает его тот же код, что в
// проде, и путь в окружении — часть проверяемого поведения.
const masterKey = randomBytes(MASTER_KEY_BYTES)
const keyFile = join(tmpdir(), `thesis-master-${randomUUID()}.key`)

// Издатель подменён и запоминает команды: живых обращений к брокеру из тестов
// не бывает, а проверять надо именно то, что ушло в команде.
const sent: ExchangeKeySave[] = []
const publisher: Pick<RabbitPublisher, 'send'> = {
  send: (_queue: string, command: unknown) => {
    sent.push(command as ExchangeKeySave)
  },
}

function configFor(allowlist: string): ConfigService<Env, true> {
  return {
    get: (key: string) => (key === 'EXCHANGE_KEYS_ALLOWLIST' ? allowlist : keyFile),
  } as unknown as ConfigService<Env, true>
}

function serviceWith(allowlist: string): KeysService {
  return new KeysService(prisma, publisher as RabbitPublisher, configFor(allowlist))
}

async function seedAccount(email: string) {
  const user = await db.prisma.user.create({ data: { email, passwordHash: 'x' } })
  const account = await db.prisma.account.create({
    data: { userId: user.id, provider: 'bybit', kind: 'exchange', baseCurrency: 'USDT' },
  })
  return { userId: user.id, accountId: account.id, email }
}

// Своя почта на каждый тест: она уникальна в базе, и список доступа строится
// вокруг неё — иначе тесты делили бы одного пользователя.
async function seedAllowed() {
  const account = await seedAccount(`keys-owner-${randomUUID()}@example.com`)
  return { ...account, keys: serviceWith(account.email) }
}

beforeAll(async () => {
  db = await withTestDb()
  process.env.APP_DATABASE_URL = db.appUrl
  writeFileSync(keyFile, `${masterKey.toString('hex')}\n`, { mode: 0o600 })
  prisma = new PrismaService()
  await prisma.$connect()
})

beforeEach(() => {
  sent.length = 0
})

afterAll(async () => {
  await prisma.$disconnect()
  await db.stop()
})

// Главное свойство: секрет не возвращается наружу и не едет по брокеру
// открытым текстом. Шифротекст при этом настоящий — расшифровывается тем же
// мастер-ключом, которым зашифрован.
it('наружу уходит маска, а секрет — только шифротекстом', async () => {
  const { userId, accountId, keys } = await seedAllowed()

  const saved = await keys.save(userId, accountId, {
    exchange: 'bybit',
    apiKey: 'bybitPublicPart7f3a',
    apiSecret: 'очень-секретный-секрет',
  })

  expect(saved.mask).toBe('bybi…7f3a')
  expect(saved.status).toBe('unverified')
  expect(JSON.stringify(saved)).not.toContain('очень-секретный-секрет')

  const command = sent[0]
  expect(command).toBeDefined()
  expect(JSON.stringify(command)).not.toContain('очень-секретный-секрет')
  // Владелец едет в команде: статус проверки воркер вернёт событием, а писать
  // его в api придётся под RLS — без userId там писать нечем.
  expect(command?.userId).toBe(userId)
  expect(
    unseal(
      {
        ciphertext: Buffer.from(command!.ciphertextBase64, 'base64'),
        nonce: Buffer.from(command!.nonceBase64, 'base64'),
        tag: Buffer.from(command!.tagBase64, 'base64'),
      },
      masterKey,
    ),
  ).toBe('очень-секретный-секрет')
})

// В таблице api со стороны человека тоже нет секрета — только маска. Проверка
// не про код, а про схему: колонки, в которую можно положить ключ, нет.
it('в строке api секрета нет, только маска и статус', async () => {
  const { userId, accountId, keys } = await seedAllowed()

  await keys.save(userId, accountId, {
    exchange: 'bybit',
    apiKey: 'bybitPublicPart0001',
    apiSecret: 'секрет-которого-не-будет',
  })

  const row = await db.prisma.apiKey.findFirstOrThrow({ where: { accountId } })
  expect(Object.values(row).join(' ')).not.toContain('секрет-которого-не-будет')
  expect(row.keyMask).toBe('bybi…0001')
  expect(row.status).toBe('unverified')
  expect(row.verifiedAt).toBeNull()
})

// Второй ключ к тому же счёту — это замена первого. И замена сбрасывает
// проверку прав: новый ключ не наследует «уже проверен» от прежнего.
it('повторная отправка заменяет ключ и сбрасывает проверку', async () => {
  const { userId, accountId, keys } = await seedAllowed()

  await keys.save(userId, accountId, {
    exchange: 'bybit',
    apiKey: 'bybitPublicPartAAAA',
    apiSecret: 'первый',
  })
  await db.prisma.apiKey.updateMany({
    where: { accountId },
    data: { status: 'active', verifiedAt: new Date() },
  })

  await keys.save(userId, accountId, {
    exchange: 'bybit',
    apiKey: 'bybitPublicPartBBBB',
    apiSecret: 'второй',
  })

  const rows = await db.prisma.apiKey.findMany({ where: { accountId } })
  expect(rows).toHaveLength(1)
  expect(rows[0]!.keyMask).toBe('bybi…BBBB')
  expect(rows[0]!.status).toBe('unverified')
  expect(rows[0]!.verifiedAt).toBeNull()
})

// Чужой счёт не принимает ключ: иначе ключ лёг бы к счёту другого человека, а
// синхронизация записала бы ему чужие сделки.
it('ключ к чужому счёту не записывается', async () => {
  const mine = await seedAllowed()
  const theirs = await seedAllowed()

  await expect(
    mine.keys.save(mine.userId, theirs.accountId, {
      exchange: 'bybit',
      apiKey: 'bybitPublicPartCCCC',
      apiSecret: 'чужой',
    }),
  ).rejects.toThrow()

  expect(await db.prisma.apiKey.count({ where: { accountId: theirs.accountId } })).toBe(0)
  expect(sent).toHaveLength(0)
})

// Фича за флагом: пока не пройден первый настоящий ключ, ввод секретов открыт
// только по списку. Отказ случается до записи и до отправки команды.
it('пользователь вне списка получает отказ, и команда не уходит', async () => {
  const { userId, accountId } = await seedAccount(`stranger-${randomUUID()}@example.com`)
  const forSomeoneElse = serviceWith(`owner-${randomUUID()}@example.com`)

  await expect(
    forSomeoneElse.save(userId, accountId, {
      exchange: 'bybit',
      apiKey: 'bybitPublicPartDDDD',
      apiSecret: 'не-должен-дойти',
    }),
  ).rejects.toThrow(ForbiddenException)

  expect(await db.prisma.apiKey.count({ where: { accountId } })).toBe(0)
  expect(sent).toHaveLength(0)
})

// Выключенная фича не требует мастер-ключа и не притворяется работающей.
it('с пустым списком фича выключена целиком', async () => {
  const { userId, accountId } = await seedAccount(`off-${randomUUID()}@example.com`)
  const disabled = new KeysService(
    prisma,
    publisher as RabbitPublisher,
    {
      get: () => '',
    } as unknown as ConfigService<Env, true>,
  )

  await expect(
    disabled.save(userId, accountId, {
      exchange: 'bybit',
      apiKey: 'bybitPublicPartEEEE',
      apiSecret: 'выключено',
    }),
  ).rejects.toThrow(ForbiddenException)
})
