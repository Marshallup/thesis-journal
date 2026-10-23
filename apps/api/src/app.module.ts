import { resolve } from 'node:path'
import { Module, StandardSchemaValidationPipe } from '@nestjs/common'
import type { MiddlewareConsumer, NestModule } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { APP_PIPE } from '@nestjs/core'
import cookieParser from 'cookie-parser'
import { LoggerModule } from 'nestjs-pino'
import { AccountsModule } from './accounts/accounts.module.ts'
import { AuthModule } from './auth/auth.module.ts'
import { envSchema } from './config/env.ts'
import { QuietLogger } from './config/quiet-logger.ts'
import type { Env } from './config/env.ts'
import { DecisionsModule } from './decisions/decisions.module.ts'
import { HealthModule } from './health/health.module.ts'
import { ImportsConsumerModule } from './imports/imports-consumer.module.ts'
import { ImportsModule } from './imports/imports.module.ts'
import { InstrumentsModule } from './instruments/instruments.module.ts'
import { KeysModule } from './keys/keys.module.ts'
import { PortfolioModule } from './portfolio/portfolio.module.ts'
import { PricesConsumerModule } from './prices/prices-consumer.module.ts'
import { PricesModule } from './prices/prices.module.ts'
import { TradesModule } from './trades/trades.module.ts'

@Module({
  imports: [
    // Standard Schema: та же Zod-схема, что и везде, без Joi и class-validator.
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envSchema,
      // Путь явно: по умолчанию он считается от cwd, а запускаемся мы из apps/api.
      envFilePath: resolve(import.meta.dirname, '../../..', '.env'),
      // Единственное прямое чтение переменной: это настройка самого
      // ConfigModule, до появления ConfigService.
      ignoreEnvFile: process.env.NODE_ENV === 'test',
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const nodeEnv = config.get('NODE_ENV', { infer: true })
        return {
          pinoHttp: {
            // В тестах логи только мешают выводу прогона.
            level:
              config.get('LOG_LEVEL', { infer: true }) ?? (nodeEnv === 'test' ? 'silent' : 'info'),
            // В разработке логи читает человек, в проде их разбирают машины.
            ...(nodeEnv === 'development'
              ? {
                  transport: {
                    target: 'pino-pretty',
                    options: { singleLine: true, translateTime: 'HH:MM:ss' },
                  },
                }
              : {}),
            // По умолчанию pino-http печатает запрос и ответ целиком, со всеми
            // заголовками: полторы тысячи знаков на строку, из них полезны
            // четыре значения.
            serializers: {
              req: (req: { method: string; url: string }) => ({
                method: req.method,
                url: req.url,
              }),
              res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
            },
            // Пробы инфраструктуры ходят в /health каждые несколько секунд.
            autoLogging: { ignore: (req: { url?: string }) => req.url === '/health' },
            // Страховка на случай, если заголовки вернутся в сериализатор:
            // там живут access-токен и refresh-cookie.
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
    InstrumentsModule,
    AccountsModule,
    ImportsModule,
    ImportsConsumerModule,
    KeysModule,
    PortfolioModule,
    PricesModule,
    PricesConsumerModule,
  ],
  // Через APP_PIPE, а не useGlobalPipes: иначе валидации не будет в тестах,
  // где приложение собирается через Test.createTestingModule.
  providers: [QuietLogger, { provide: APP_PIPE, useClass: StandardSchemaValidationPipe }],
})
export class AppModule implements NestModule {
  // Middleware здесь, а не в main.ts, по той же причине: чтобы работало в тестах.
  configure(consumer: MiddlewareConsumer): void {
    // `{*path}`, а не `*`: безымянная звёздочка в path-to-regexp 8 устарела.
    // Скобки оставляют сегмент необязательным — покрытие то же.
    consumer.apply(cookieParser()).forRoutes('{*path}')
  }
}
