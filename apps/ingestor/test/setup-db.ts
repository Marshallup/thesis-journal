import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { PrismaClient, PrismaPg } from '@thesis/db'

const repoRoot = resolve(import.meta.dirname, '../../..')
const initScript = resolve(repoRoot, 'docker/postgres/init-app-role.sh')

// Источник значений для тестов: скрипт получает их из окружения контейнера,
// поэтому разойтись со строкой подключения они не могут.
const appRole = 'thesis_app'
const appPassword = 'devpassword'
const ingestorRole = 'thesis_ingestor'

// Тип выписан явно: выведенный ссылается на внутренние файлы генерата Prisma,
// и TypeScript справедливо считает такой тип непортабельным (TS2883).
export type TestDb = {
  prisma: PrismaClient
  url: string
  appUrl: string
  stop: () => Promise<void>
}

export async function withTestDb(): Promise<TestDb> {
  if (!existsSync(initScript)) {
    throw new Error(`нет ${initScript}: без роли приложения RLS в тестах не работает`)
  }

  // Тот же скрипт, что монтирует compose. Файл копируется до старта контейнера,
  // поэтому entrypoint выполняет его как обычный initdb-скрипт — до миграций,
  // иначе alter default privileges не накроет их таблицы.
  const container = await new PostgreSqlContainer('postgres:18-alpine')
    .withEnvironment({
      APP_DB_ROLE: appRole,
      APP_DB_PASSWORD: appPassword,
      INGESTOR_DB_ROLE: ingestorRole,
      INGESTOR_DB_PASSWORD: appPassword,
    })
    .withCopyFilesToContainer([
      {
        source: initScript,
        target: '/docker-entrypoint-initdb.d/init-app-role.sh',
        // Иначе entrypoint не выполнит его, а подключит через source.
        mode: 0o755,
      },
    ])
    .start()

  const url = container.getConnectionUri()
  const host = `${container.getHost()}:${container.getPort()}`
  const appUrl = `postgresql://${appRole}:${appPassword}@${host}/${container.getDatabase()}`

  // Из корня, иначе CLI не найдёт prisma.config.ts. DATABASE_URL здесь
  // перебивает рабочий файл: dotenv не переписывает уже заданные переменные.
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  })

  // Владелец и суперюзер: RLS его не ограничивает. Годится для сидинга фикстур
  // и очистки, но проверять изоляцию через него нельзя — он её не видит.
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })

  return {
    prisma,
    url,
    appUrl,
    stop: async () => {
      await prisma.$disconnect()
      await container.stop()
    },
  }
}
