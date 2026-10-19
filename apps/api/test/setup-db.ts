import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { PrismaClient, PrismaPg } from '@thesis/db'

const repoRoot = resolve(import.meta.dirname, '../../..')

// Тип выписан явно: выведенный ссылается на внутренние файлы генерата Prisma,
// и TypeScript справедливо считает такой тип непортабельным (TS2883).
export type TestDb = {
  prisma: PrismaClient
  url: string
  stop: () => Promise<void>
}

export async function withTestDb(): Promise<TestDb> {
  const container = await new PostgreSqlContainer('postgres:18-alpine').start()
  const url = container.getConnectionUri()

  // Из корня, иначе CLI не найдёт prisma.config.ts. DATABASE_URL здесь
  // перебивает рабочий файл: dotenv не переписывает уже заданные переменные.
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  })

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })

  return {
    prisma,
    url,
    stop: async () => {
      await prisma.$disconnect()
      await container.stop()
    },
  }
}
