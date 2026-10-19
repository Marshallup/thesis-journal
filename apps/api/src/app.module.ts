import { Module } from '@nestjs/common'
import { LoggerModule } from 'nestjs-pino'
import { HealthModule } from './health/health.module.ts'

@Module({
  imports: [
    LoggerModule.forRoot({
      // В тестах логи только мешают выводу прогона.
      pinoHttp: { level: process.env.NODE_ENV === 'test' ? 'silent' : 'info' },
    }),
    HealthModule,
  ],
})
export class AppModule {}
