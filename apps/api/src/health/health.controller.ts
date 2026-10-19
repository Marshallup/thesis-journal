import { Controller, Get, ServiceUnavailableException } from '@nestjs/common'
import { PrismaService } from '../db/prisma.service.ts'

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check() {
    try {
      await this.prisma.$queryRaw`select 1`
      return { status: 'ok', db: 'up' }
    } catch {
      // Объект из исключения уходит в тело ответа как есть — контракт обещает его.
      throw new ServiceUnavailableException({ status: 'error', db: 'down' })
    }
  }
}
