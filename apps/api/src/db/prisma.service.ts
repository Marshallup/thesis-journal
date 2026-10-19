import { Injectable } from '@nestjs/common'
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { PrismaClient, PrismaPg } from '@thesis/db'

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
