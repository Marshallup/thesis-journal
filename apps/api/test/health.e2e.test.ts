import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { AppModule } from '../src/app.module.ts'
import { PrismaService } from '../src/db/prisma.service.ts'
import { configureApp } from '../src/config/configure-app.ts'
import { withTestDb } from './setup-db.ts'

let app: Awaited<ReturnType<typeof createApp>>
let db: Awaited<ReturnType<typeof withTestDb>>

async function createApp() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  const instance = moduleRef.createNestApplication()
  // Та же настройка, что в bootstrap: иначе тесты ходят по другим адресам,
  // чем прод, и префикс остаётся непроверенным.
  configureApp(instance)
  await instance.init()
  return instance
}

beforeAll(async () => {
  db = await withTestDb()
  process.env.DATABASE_URL = db.url
  process.env.APP_DATABASE_URL = db.appUrl
  app = await createApp()
})

afterAll(async () => {
  await app.close()
  await db.stop()
})

it('отвечает ok, когда база доступна', async () => {
  const res = await request(app.getHttpServer()).get('/health')

  expect(res.status).toBe(200)
  expect(res.body).toMatchObject({ status: 'ok', details: { database: { status: 'up' } } })
})

it('отвечает 503, когда база недоступна', async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue({
      // Именно этот метод зовёт PrismaHealthIndicator для SQL-клиента.
      $queryRawUnsafe: () => Promise.reject(new Error('connection refused')),
      $connect: () => Promise.resolve(),
      $disconnect: () => Promise.resolve(),
    })
    .compile()
  const broken = moduleRef.createNestApplication()
  // Та же настройка, что в bootstrap, обязательна с появлением шлюза сокетов:
  // без неё Nest ищет адаптер socket.io, не находит и выходит из процесса.
  configureApp(broken)
  await broken.init()

  const res = await request(broken.getHttpServer()).get('/health')

  expect(res.status).toBe(503)
  expect(res.body).toMatchObject({ status: 'error', details: { database: { status: 'down' } } })

  await broken.close()
})
