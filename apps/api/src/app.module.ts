import { resolve } from 'node:path'
import { Module, StandardSchemaValidationPipe } from '@nestjs/common'
import type { MiddlewareConsumer, NestModule } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { APP_PIPE } from '@nestjs/core'
import cookieParser from 'cookie-parser'
import { LoggerModule } from 'nestjs-pino'
import { AuthModule } from './auth/auth.module.ts'
import { envSchema } from './config/env.ts'
import { HealthModule } from './health/health.module.ts'

@Module({
  imports: [
    // Standard Schema: та же Zod-схема, что и везде, без Joi и class-validator.
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envSchema,
      // Путь явно: по умолчанию он считается от cwd, а запускаемся мы из apps/api.
      envFilePath: resolve(import.meta.dirname, '../../..', '.env'),
      // В тестах окружение задаёт сам тест: иначе локальный файл маскировал бы
      // пропущенную переменную, и в CI это всплыло бы падением.
      ignoreEnvFile: process.env.NODE_ENV === 'test',
    }),
    LoggerModule.forRoot({
      // В тестах логи только мешают выводу прогона.
      pinoHttp: { level: process.env.NODE_ENV === 'test' ? 'silent' : 'info' },
    }),
    AuthModule,
    HealthModule,
  ],
  // Через APP_PIPE, а не useGlobalPipes в main.ts: иначе валидация не включится
  // в тестах, где приложение собирается через Test.createTestingModule.
  providers: [{ provide: APP_PIPE, useClass: StandardSchemaValidationPipe }],
})
export class AppModule implements NestModule {
  // Middleware здесь, а не в main.ts, по той же причине: чтобы работало в тестах.
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(cookieParser()).forRoutes('*')
  }
}
