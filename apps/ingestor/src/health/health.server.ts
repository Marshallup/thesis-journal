import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { Injectable, Logger } from '@nestjs/common'
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Env } from '../config/env.ts'

// HTTP воркеру не нужен, а проба нужна: по ней ходит docker compose, и задача
// 48 проверяет деплой запросом к ней. Поэтому node:http в двадцать строк, а не
// Express со всем конвейером Nest.
@Injectable()
export class HealthServer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(HealthServer.name)
  private server: Server | null = null

  constructor(private readonly config: ConfigService<Env, true>) {}

  onApplicationBootstrap(): Promise<void> {
    const port = this.config.get('INGESTOR_PORT', { infer: true })
    const server = createServer((request, response) => {
      // Пока проба отвечает только «процесс жив»: ни базы, ни брокеров у
      // воркера ещё нет. Их проверки добавляются вместе с ними — проба,
      // которая обещает больше, чем проверяет, хуже отсутствующей.
      if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ status: 'ok' }))
        return
      }
      response.writeHead(404).end()
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
