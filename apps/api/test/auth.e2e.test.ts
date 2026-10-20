import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { AppModule } from '../src/app.module.ts'
import { AuthService } from '../src/auth/auth.service.ts'
import { withTestDb } from './setup-db.ts'

const PASSWORD = 'correct horse battery'

let app: Awaited<ReturnType<typeof createApp>>
let db: Awaited<ReturnType<typeof withTestDb>>

async function createApp() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  const instance = moduleRef.createNestApplication()
  await instance.init()
  return instance
}

// Логин обязан вернуть refresh-cookie: без неё дальше проверять нечего,
// и падение должно называть причину здесь, а не через три шага.
function refreshCookie(response: request.Response): string {
  const cookie = response.headers['set-cookie']
  if (!cookie) throw new Error('ответ не выставил refresh-cookie')
  return cookie
}

async function registerAndLogin(email: string) {
  const agent = request.agent(app.getHttpServer())

  const registered = await agent.post('/auth/register').send({ email, password: PASSWORD })
  expect(registered.status).toBe(201)

  const login = await agent.post('/auth/login').send({ email, password: PASSWORD })
  expect(login.status).toBe(200)

  return { agent, registered, login }
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

it('не принимает refresh-токен повторно', async () => {
  const { agent, login } = await registerAndLogin('rotate@example.com')
  const first = refreshCookie(login)

  // агент обновился — токен провернулся, cookie заменилась
  const rotated = await agent.post('/auth/refresh')
  expect(rotated.status).toBe(200)

  // старая cookie больше не принимается
  const replay = await request(app.getHttpServer()).post('/auth/refresh').set('Cookie', first)
  expect(replay.status).toBe(401)

  // а у легитимного клиента сессия жива: отзыва цепочки в этой задаче нет
  const again = await agent.post('/auth/refresh')
  expect(again.status).toBe(200)
})

it('при параллельной ротации одного токена успешна ровно одна', async () => {
  // Через HTTP гонки не получается: supertest-запросы сериализуются, и
  // проигравшие просто не находят токен. Контенция нужна внутри Postgres,
  // поэтому зовём сервис напрямую — восемь транзакций разом.
  const auth = app.get(AuthService)
  await auth.register({ email: 'race@example.com', password: PASSWORD })
  const session = await auth.login({ email: 'race@example.com', password: PASSWORD })

  const outcomes = await Promise.allSettled(
    Array.from({ length: 8 }, () => auth.rotate(session.refreshToken)),
  )

  expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1)
})

it('считает email без учёта регистра при регистрации', async () => {
  const first = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email: 'case@example.com', password: PASSWORD })
  expect(first.status).toBe(201)

  const second = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email: 'CASE@EXAMPLE.COM', password: PASSWORD })
  expect(second.status).toBe(409)
})

it('отдаёт текущего пользователя по access-токену', async () => {
  const { registered, login } = await registerAndLogin('me@example.com')
  const { id } = registered.body as { id: string }
  const { accessToken } = login.body as { accessToken: string }

  const ok = await request(app.getHttpServer())
    .get('/auth/me')
    .set('Authorization', `Bearer ${accessToken}`)
  expect(ok.status).toBe(200)
  expect(ok.body).toEqual({ userId: id })

  const anonymous = await request(app.getHttpServer()).get('/auth/me')
  expect(anonymous.status).toBe(401)

  // Подделанная подпись: меняем последний символ.
  const tampered = await request(app.getHttpServer())
    .get('/auth/me')
    .set(
      'Authorization',
      `Bearer ${accessToken.slice(0, -1)}${accessToken.endsWith('a') ? 'b' : 'a'}`,
    )
  expect(tampered.status).toBe(401)
})
