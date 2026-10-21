import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module.ts'
import { PortfolioController } from './portfolio.controller.ts'
import { PortfolioService } from './portfolio.service.ts'

@Module({
  imports: [DbModule],
  controllers: [PortfolioController],
  providers: [PortfolioService],
  exports: [PortfolioService],
})
export class PortfolioModule {}
