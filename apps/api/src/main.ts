import { Logger as NestLogger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { LoggerErrorInterceptor } from 'nestjs-pino'
import { AppModule } from './app.module.ts'
import { API_PREFIX, API_VERSION } from './config/api.ts'
import { configureApp } from './config/configure-app.ts'
import { QuietLogger } from './config/quiet-logger.ts'
import type { Env } from './config/env.ts'

async function bootstrap() {
  // bufferLogs: иначе первые строки уходят мимо pino.
  const app = await NestFactory.create(AppModule, { bufferLogs: true })

  configureApp(app)

  // QuietLogger вместо Logger: он понижает стартовую простыню Nest до debug.
  app.useLogger(app.get(QuietLogger))
  app.useGlobalInterceptors(new LoggerErrorInterceptor())
  // По SIGTERM Nest дорабатывает текущую задачу и зовёт onModuleDestroy.
  app.enableShutdownHooks()

  const config = new DocumentBuilder()
    .setTitle('Thesis API')
    .setDescription('Дневник инвестиционных решений')
    .setVersion('0.1.0')
    // Без этого в /docs нет кнопки Authorize и защищённые маршруты не потыкать.
    .addBearerAuth()
    .build()
  // Фабрика, а не готовый документ: собирается при первом заходе в /docs.
  SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, config))

  const port = app.get(ConfigService<Env, true>).get('PORT', { infer: true })
  await app.listen(port)

  // Сам Nest адрес не печатает, а он нужен каждый запуск.
  const log = new NestLogger('Bootstrap')
  log.log(`api http://localhost:${port}/${API_PREFIX}/v${API_VERSION}`)
  log.log(`docs http://localhost:${port}/docs`)
}

// `void bootstrap()` проглотил бы отказ промиса, и падение при старте
// выглядело бы как молчаливый выход.
await bootstrap()
