import { Injectable } from '@nestjs/common'
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { PrismaClient, PrismaPg } from '@thesis/db'

// Мимо ConfigService вынужденно: он снимает значения при импорте модуля, а
// адрес контейнера Testcontainers известен позже. Та же причина, что в api.
function connectionString(): string {
  // Своя роль, а не роль api: у неё права на схему ingestor и только чтение
  // справочника инструментов в public. Отката на DATABASE_URL нет намеренно —
  // иначе забытая переменная даёт воркера, работающего от владельца базы, и
  // граница между сервисами существует только на словах.
  const url = process.env.INGESTOR_DATABASE_URL
  if (!url) throw new Error('INGESTOR_DATABASE_URL is not set')
  return url
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({ adapter: new PrismaPg({ connectionString: connectionString() }) })
  }

  async onModuleInit() {
    await this.$connect()
  }

  async onModuleDestroy() {
    await this.$disconnect()
  }

  // withUser здесь нет и не будет: в схеме ingestor нет пользовательских
  // данных, а значит нет и RLS, под которую нужно подставлять пользователя.
}
