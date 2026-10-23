import { RedisContainer } from '@testcontainers/redis'
import { Redis } from 'ioredis'

export type TestRedis = {
  url: string
  // Отдельный клиент на каждого «потребителя»: в тестах про общий лимит важно,
  // что состояние живёт в Redis, а не в одном подключении.
  client: () => Redis
  stop: () => Promise<void>
}

export async function withTestRedis(): Promise<TestRedis> {
  const container = await new RedisContainer('redis:8-alpine').start()
  const url = container.getConnectionUrl()
  const clients: Redis[] = []

  return {
    url,
    client: () => {
      const client = new Redis(url)
      clients.push(client)
      return client
    },
    stop: async () => {
      await Promise.all(clients.map((client) => client.quit()))
      await container.stop()
    },
  }
}
