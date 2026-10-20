import { resolve } from 'node:path'
import { Module, StandardSchemaValidationPipe } from '@nestjs/common'
import type { MiddlewareConsumer, NestModule } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { APP_PIPE } from '@nestjs/core'
import cookieParser from 'cookie-parser'
import { LoggerModule } from 'nestjs-pino'
import { AuthModule } from './auth/auth.module.ts'
import { envSchema } from './config/env.ts'
import type { Env } from './config/env.ts'
import { DecisionsModule } from './decisions/decisions.module.ts'
import { HealthModule } from './health/health.module.ts'
import { TradesModule } from './trades/trades.module.ts'

@Module({
  imports: [
    // Standard Schema: та же Zod-схема, что и везде, без Joi и class-validator.
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envSchema,
      // Путь явно: по умолчанию он считается от cwd, а запускаемся мы из apps/api.
      envFilePath: resolve(import.meta.dirname, '../../..', '.env'),
      // Единственное место, где переменная читается напрямую, и иначе никак:
      // это настройка самого ConfigModule, до появления ConfigService.
      ignoreEnvFile: process.env.NODE_ENV === 'test',
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const nodeEnv = config.get('NODE_ENV', { infer: true })
        return {
          pinoHttp: {
            // В тестах логи только мешают выводу прогона.
            level: nodeEnv === 'test' ? 'silent' : 'info',
            // В разработке логи читает человек, в проде их разбирают машины.
            ...(nodeEnv === 'development'
              ? {
                  transport: {
                    target: 'pino-pretty',
                    options: { singleLine: true, translateTime: 'HH:MM:ss' },
                  },
                }
              : {}),
            // pino-http пишет заголовки целиком, а там токен и refresh-cookie.
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'res.headers["set-cookie"]',
              ],
              censor: '[redacted]',
            },
          },
        }
      },
    }),
    AuthModule,
    HealthModule,
    TradesModule,
    DecisionsModule,
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
