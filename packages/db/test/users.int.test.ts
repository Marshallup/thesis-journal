import { afterAll, beforeAll, expect, it } from 'vitest'
import { withTestDb } from '../../../apps/api/test/setup-db.ts'

let db: Awaited<ReturnType<typeof withTestDb>>

beforeAll(async () => {
  db = await withTestDb()
})

afterAll(async () => {
  await db.stop()
})

it('не даёт зарегистрировать два аккаунта на один email', async () => {
  await db.prisma.user.create({ data: { email: 'a@b.c', passwordHash: 'x' } })

  await expect(
    db.prisma.user.create({ data: { email: 'a@b.c', passwordHash: 'y' } }),
  ).rejects.toMatchObject({ code: 'P2002' })
})

it('не нормализует регистр email на уровне БД — это делает код', async () => {
  await db.prisma.user.create({ data: { email: 'mixed@b.c', passwordHash: 'x' } })
  await db.prisma.user.create({ data: { email: 'MIXED@b.c', passwordHash: 'y' } })

  const count = await db.prisma.user.count({
    where: { email: { in: ['mixed@b.c', 'MIXED@b.c'] } },
  })
  expect(count).toBe(2)
})
