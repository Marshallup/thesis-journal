import { Controller, Get } from '@nestjs/common'
import { HealthCheck, HealthCheckService, PrismaHealthIndicator } from '@nestjs/terminus'
import { PrismaService } from '../db/prisma.service.ts'

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: PrismaHealthIndicator,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    // Таймаут обязателен: без него подвисшая база подвешивает и саму пробу,
    // а балансировщик так и не узнает, что сервис нездоров.
    return this.health.check([
      () => this.database.pingCheck('database', this.prisma).withTimeout(1500),
    ])
  }
}
