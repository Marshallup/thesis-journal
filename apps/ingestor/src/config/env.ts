import { z } from 'zod'

// Только то, что процесс уже читает. База и брокеры добавляются в задачах
// 19b–19f: переменная, которую никто не использует, превращает проверку
// окружения в формальность.
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  // Свой порт: HTTP у воркера только под пробу, и занимать 3000 ему незачем.
  INGESTOR_PORT: z.coerce.number().default(3001),
})

export type Env = z.infer<typeof envSchema>
