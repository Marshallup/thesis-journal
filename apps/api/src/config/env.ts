import { z } from 'zod'

// В Zod 4 форматы живут на верхнем уровне: z.url(), не z.string().url().
export const envSchema = z.object({
  // Владелец: миграции и generate. Приложение ходит под ограниченной ролью.
  DATABASE_URL: z.url(),
  APP_DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  // Список через запятую, как его ждёт librdkafka: это не URL.
  KAFKA_BROKERS: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Необязательный: по умолчанию выводится из NODE_ENV. Нужен, чтобы вернуть
  // стартовую простыню Nest, понижённую QuietLogger до debug.
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  PORT: z.coerce.number().default(3000),
})

export type Env = z.infer<typeof envSchema>
