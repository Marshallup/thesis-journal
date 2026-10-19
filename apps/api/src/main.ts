// Должен стоять первым: Nest читает метаданные декораторов через reflect-metadata.
import 'reflect-metadata'
import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { Logger, LoggerErrorInterceptor } from 'nestjs-pino'
import { AppModule } from './app.module.ts'
import type { Env } from './config/env.ts'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true })

  app.useLogger(app.get(Logger))
  app.useGlobalInterceptors(new LoggerErrorInterceptor())
  // По SIGTERM Nest дорабатывает текущую задачу и зовёт onModuleDestroy.
  app.enableShutdownHooks()

  const config = new DocumentBuilder()
    .setTitle('Thesis API')
    .setDescription('Дневник инвестиционных решений')
    .setVersion('0.1.0')
    .build()
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config))

  await app.listen(app.get(ConfigService<Env, true>).get('PORT', { infer: true }))
}

void bootstrap()
