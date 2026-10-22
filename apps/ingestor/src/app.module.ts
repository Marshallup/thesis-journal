import { resolve } from 'node:path'
import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { LoggerModule } from 'nestjs-pino'
import { envSchema } from './config/env.ts'
import { QuietLogger } from './config/quiet-logger.ts'
import type { Env } from './config/env.ts'
import { DbModule } from './db/db.module.ts'
import { HealthServer } from './health/health.server.ts'
import { PricesSchedulerModule } from './prices/prices-scheduler.module.ts'

const ENV_FILE = '.env'

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envSchema,
      // Один файл окружения на монорепозиторий: процессы разные, стек один.
      // Путь явно: по умолчанию он считается от cwd, а запускаемся мы из
      // apps/ingestor.
      envFilePath: resolve(import.meta.dirname, '../../..', ENV_FILE),
      ignoreEnvFile: process.env.NODE_ENV === 'test',
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const nodeEnv = config.get('NODE_ENV', { infer: true })
        return {
          pinoHttp: {
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
          },
        }
      },
    }),
    DbModule,
    PricesSchedulerModule,
  ],
  providers: [QuietLogger, HealthServer],
})
export class AppModule {}
