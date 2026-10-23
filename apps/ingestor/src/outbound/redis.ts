import { ConfigService } from '@nestjs/config'
import { Redis } from 'ioredis'
import type { Provider } from '@nestjs/common'
import type { Env } from '../config/env.ts'

// Токен провайдера: клиент один на процесс. Второй экземпляр — это второе
// соединение к Redis ради тех же двух ключей.
export const REDIS = 'REDIS_CLIENT'

export const redisProvider: Provider = {
  provide: REDIS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    new Redis(config.get('REDIS_URL', { infer: true }), {
      // Подключение по первой команде: воркер, которому за всю жизнь не
      // понадобился внешний вызов, соединения не держит.
      lazyConnect: true,
      // По умолчанию ioredis копит команды и ждёт вечно. Ограничитель, который
      // ждёт Redis дольше, чем сам лимит, хуже отсутствующего.
      maxRetriesPerRequest: 2,
    }),
}
