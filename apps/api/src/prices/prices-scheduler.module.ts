import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'
import { PricesScheduler } from './prices.scheduler.ts'
import { PricesModule } from './prices.module.ts'

@Module({
  imports: [PricesModule, ScheduleModule.forRoot()],
  providers: [PricesScheduler],
})
export class PricesSchedulerModule {}
