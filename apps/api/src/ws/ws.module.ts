import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.ts'
import { PortfolioModule } from '../portfolio/portfolio.module.ts'
import { PortfolioGateway } from './portfolio.gateway.ts'

// Шлюз один, а модуль отдельный: так видно, что сокеты зависят от авторизации
// и портфеля, и ничего больше.
@Module({
  imports: [AuthModule, PortfolioModule],
  providers: [PortfolioGateway],
})
export class WsModule {}
