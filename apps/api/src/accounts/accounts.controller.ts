import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { ApiBearerAuth, ApiBody, ApiOperation } from '@nestjs/swagger'
import type { Prisma } from '@thesis/db'
import { CurrentUser } from '../auth/current-user.decorator.ts'
import type { AuthenticatedUser } from '../auth/current-user.decorator.ts'
import { AccountsService } from './accounts.service.ts'
import { createAccountOpenApiSchema, createAccountSchema } from './dto.ts'
import type { CreateAccount } from './dto.ts'

// То же осознанное приведение, что в auth.controller.ts.
type ApiBodySchema = Extract<Parameters<typeof ApiBody>[0], { schema: unknown }>['schema']

@Controller('accounts')
@UseGuards(AuthGuard('jwt'))
@ApiBearerAuth()
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  @ApiOperation({ summary: 'Счета пользователя' })
  list(@CurrentUser() user: AuthenticatedUser): Promise<Prisma.AccountModel[]> {
    return this.accounts.list(user.userId)
  }

  @Post()
  @ApiOperation({ summary: 'Завести счёт. Первый шаг записи, а не настройки' })
  @ApiBody({ schema: createAccountOpenApiSchema as ApiBodySchema })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body({ schema: createAccountSchema }) body: CreateAccount,
  ): Promise<Prisma.AccountModel> {
    return this.accounts.create(user.userId, body)
  }
}
