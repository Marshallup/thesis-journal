import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.ts'
import { PortfolioModule } from '../portfolio/portfolio.module.ts'
import { PortfolioGateway } from './portfolio.gateway.ts'

// Шлюз один, а модуль отдельный: adapter подключается настройкой приложения, и
// тест, которому сокеты не нужны, этот модуль не поднимает.
@Module({
  imports: [AuthModule, PortfolioModule],
  providers: [PortfolioGateway],
})
export class WsModule {}
