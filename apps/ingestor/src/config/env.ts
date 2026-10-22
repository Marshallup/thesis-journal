import { z } from 'zod'

// Только то, что процесс уже читает: воркеру нужны база, оба брокера и порт
// пробы. Переменная, которую никто не использует, превращает проверку
// окружения в формальность.
export const envSchema = z.object({
  // Роль воркера: своя схема и только чтение справочника в public.
  INGESTOR_DATABASE_URL: z.url(),
  // Список через запятую, как его ждёт librdkafka. Не z.url(): это не один
  // адрес и не URL — `localhost:9092`.
  KAFKA_BROKERS: z.string().min(1),
  RABBITMQ_URL: z.url(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  // Свой порт: HTTP у воркера только под пробу, и занимать 3000 ему незачем.
  INGESTOR_PORT: z.coerce.number().default(3001),
})

export type Env = z.infer<typeof envSchema>
