import { Injectable } from '@nestjs/common'
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { PrismaClient, PrismaPg } from '@thesis/db'

// Единственное место, где адрес базы читается не через ConfigService, и это
// вынужденно: ConfigModule снимает значения при импорте модуля, а адрес
// контейнера Testcontainers известен только позже. Через ConfigService клиент
// получал заглушку и падал с DatabaseNotReachable — проверено.
function connectionString(): string {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
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
}
