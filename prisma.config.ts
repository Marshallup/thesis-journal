// Prisma 7 переменные окружения сама не читает — отсюда явный dotenv.
import 'dotenv/config'
import { defineConfig, env } from 'prisma/config'

export default defineConfig({
  schema: 'packages/db/prisma/schema.prisma',
  migrations: { path: 'packages/db/prisma/migrations' },
  datasource: { url: env('DATABASE_URL') },
})
