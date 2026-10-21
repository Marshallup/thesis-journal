import { Controller, Get, UseGuards } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { ApiBearerAuth, ApiOperation } from '@nestjs/swagger'
import type { Prisma } from '@thesis/db'
import { CurrentUser } from '../auth/current-user.decorator.ts'
import type { AuthenticatedUser } from '../auth/current-user.decorator.ts'
import { PrismaService } from '../db/prisma.service.ts'

// Форме решения нужно выбрать счёт, а эндпоинта счетов в плане не было.
// Чтение, не запись: счета пока появляются только при импорте и вручную в базе.
@Controller('accounts')
@UseGuards(AuthGuard('jwt'))
@ApiBearerAuth()
export class AccountsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'Счета пользователя' })
  // Тип выписан явно: выведенный ссылается на внутренние файлы генерата Prisma.
  list(@CurrentUser() user: AuthenticatedUser): Promise<Prisma.AccountModel[]> {
    return this.prisma.withUser(user.userId, (tx) =>
      tx.account.findMany({ orderBy: { createdAt: 'asc' } }),
    )
  }
}
