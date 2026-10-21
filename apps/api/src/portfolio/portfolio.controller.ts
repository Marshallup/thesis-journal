import { Controller, Get, UseGuards } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { ApiBearerAuth, ApiOperation } from '@nestjs/swagger'
import { CurrentUser } from '../auth/current-user.decorator.ts'
import type { AuthenticatedUser } from '../auth/current-user.decorator.ts'
import { PortfolioService } from './portfolio.service.ts'

@Controller('portfolio')
@UseGuards(AuthGuard('jwt'))
@ApiBearerAuth()
export class PortfolioController {
  constructor(private readonly portfolio: PortfolioService) {}

  @Get()
  @ApiOperation({ summary: 'Остатки, затраты, реализованный результат и комиссии по бумагам' })
  summary(@CurrentUser() user: AuthenticatedUser) {
    return this.portfolio.summary(user.userId)
  }
}
