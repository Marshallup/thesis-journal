// Должен стоять первым: Nest читает метаданные декораторов через reflect-metadata.
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { Logger, LoggerErrorInterceptor } from 'nestjs-pino'
import { AppModule } from './app.module.ts'
import { loadEnv } from './config/env.ts'

async function bootstrap() {
  const env = loadEnv()
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

  await app.listen(env.PORT)
}

void bootstrap()
