import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { AppModule } from '../src/app.module.ts'
import { PrismaService } from '../src/db/prisma.service.ts'
import { withTestDb } from './setup-db.ts'

let app: Awaited<ReturnType<typeof createApp>>
let db: Awaited<ReturnType<typeof withTestDb>>

async function createApp() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  const instance = moduleRef.createNestApplication()
  await instance.init()
  return instance
}

beforeAll(async () => {
  db = await withTestDb()
  process.env.DATABASE_URL = db.url
  app = await createApp()
})

afterAll(async () => {
  await app.close()
  await db.stop()
})

it('отвечает ok, когда база доступна', async () => {
  const res = await request(app.getHttpServer()).get('/health')

  expect(res.status).toBe(200)
  expect(res.body).toEqual({ status: 'ok', db: 'up' })
})

it('отвечает 503, когда база недоступна', async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue({
      $queryRaw: () => Promise.reject(new Error('connection refused')),
      $connect: () => Promise.resolve(),
      $disconnect: () => Promise.resolve(),
    })
    .compile()
  const broken = moduleRef.createNestApplication()
  await broken.init()

  const res = await request(broken.getHttpServer()).get('/health')

  expect(res.status).toBe(503)
  expect(res.body).toEqual({ status: 'error', db: 'down' })

  await broken.close()
})
