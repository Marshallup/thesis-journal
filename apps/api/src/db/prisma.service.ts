import { Injectable } from '@nestjs/common'
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { PrismaClient, PrismaPg } from '@thesis/db'
import type { Prisma } from '@thesis/db'

// Единственное место, где адрес базы читается не через ConfigService, и это
// вынужденно: ConfigModule снимает значения при импорте модуля, а адрес
// контейнера Testcontainers известен только позже. Через ConfigService клиент
// получал заглушку и падал с DatabaseNotReachable — проверено.
function connectionString(): string {
  // Роль приложения, а не владелец: владелец и суперюзер обходят RLS.
  // Отката на DATABASE_URL нет намеренно — иначе забытая переменная даёт
  // работающий сервис с выключенным вторым рубежом из docs/design.md §5.
  const url = process.env.APP_DATABASE_URL
  if (!url) throw new Error('APP_DATABASE_URL is not set')
  return url
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    // Prisma 7: драйвер-адаптер обязателен, Rust-движка больше нет.
    super({ adapter: new PrismaPg({ connectionString: connectionString() }) })
  }

  async onModuleInit() {
    await this.$connect()
  }

  async onModuleDestroy() {
    await this.$disconnect()
  }

  // Третий аргумент set_config — is_local: значение живёт до конца транзакции.
  // Без него оно останется на соединении и уедет через пул к чужому запросу.
  async withUser<T>(userId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`select set_config('app.user_id', ${userId}, true)`
      return fn(tx)
    })
  }
}
