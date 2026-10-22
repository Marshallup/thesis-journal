import { Logger as NestLogger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.ts'
import { QuietLogger } from './config/quiet-logger.ts'

async function bootstrap() {
  // createApplicationContext, а не create: HTTP-сервер воркеру не нужен.
  // Проба поднимается своим слушателем в HealthServer.
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true })

  app.useLogger(app.get(QuietLogger))
  // По SIGTERM воркер дорабатывает текущую задачу и закрывает соединения.
  app.enableShutdownHooks()

  new NestLogger('Bootstrap').log('ingestor поднят')
}

// `void bootstrap()` проглотил бы отказ промиса, и падение при старте
// выглядело бы как молчаливый выход.
await bootstrap()
