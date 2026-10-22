import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'
import { PricesModule } from './prices.module.ts'
import { PricesScheduler } from './prices.scheduler.ts'

// Единственное, что поднимает цикл опроса. Тесты этот модуль не импортируют —
// и поэтому живых обращений к бирже в них не бывает по построению, а не по
// внимательности.
@Module({
  imports: [PricesModule, ScheduleModule.forRoot()],
  providers: [PricesScheduler],
})
export class PricesSchedulerModule {}
