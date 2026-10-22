import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { Injectable, Logger } from '@nestjs/common'
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Env } from '../config/env.ts'
import { PrismaService } from '../db/prisma.service.ts'

// Таймаут обязателен: без него подвисшая база подвешивает и саму пробу, а
// оркестратор так и не узнает, что сервис нездоров. Та же причина и то же
// значение, что у пробы api.
const CHECK_TIMEOUT_MS = 1500

// HTTP воркеру не нужен, а проба нужна: по ней ходит docker compose, и задача
// 48 проверяет деплой запросом к ней. Поэтому node:http в тридцать строк, а не
// Express со всем конвейером Nest.
@Injectable()
export class HealthServer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(HealthServer.name)
  private server: Server | null = null

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
  ) {}

  // Проверяется то, без чего воркер бесполезен: без базы ему некуда писать
  // цены. Брокеры добавятся в пробу вместе с собой, в задачах 19d и 19f.
  private async database(): Promise<boolean> {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('таймаут')), CHECK_TIMEOUT_MS),
    )
    try {
      await Promise.race([this.prisma.$queryRaw`select 1`, timeout])
      return true
    } catch (error) {
      this.log.warn(`проба: база недоступна (${String(error)})`)
      return false
    }
  }

  onApplicationBootstrap(): Promise<void> {
    const port = this.config.get('INGESTOR_PORT', { infer: true })
    const server = createServer((request, response) => {
      if (request.url !== '/health') {
        response.writeHead(404).end()
        return
      }
      void this.database().then((ok) => {
        response.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ status: ok ? 'ok' : 'error', database: ok }))
      })
    })
    this.server = server

    return new Promise((resolve) => {
      server.listen(port, () => {
        this.log.log(`health http://localhost:${port}/health`)
        resolve()
      })
    })
  }

  // Без этого SIGTERM не закрывает слушающий сокет, и процесс висит.
  onApplicationShutdown(): Promise<void> {
    const server = this.server
    if (!server) return Promise.resolve()
    return new Promise((resolve) => server.close(() => resolve()))
  }
}
