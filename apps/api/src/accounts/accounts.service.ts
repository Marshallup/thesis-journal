import { ConflictException, Injectable } from '@nestjs/common'
import { Prisma } from '@thesis/db'
import { PrismaService } from '../db/prisma.service.ts'
import type { CreateAccount } from './dto.ts'

// Record без запасного варианта: добавишь провайдера в схему и забудешь здесь —
// не соберётся. Значение paper сюда не входит намеренно: бумажный режим
// появится в задаче 35, а до тех пор помечать им счета нечем и незачем.
const VENUE: Record<CreateAccount['provider'], 'broker' | 'exchange' | 'manual'> = {
  manual: 'manual',
  sber: 'broker',
  tinvest: 'broker',
  bybit: 'exchange',
  bitget: 'exchange',
}

export function venueOf(provider: CreateAccount['provider']): string {
  return VENUE[provider]
}

@Injectable()
export class AccountsService {
  constructor(private readonly prisma: PrismaService) {}

  list(userId: string): Promise<Prisma.AccountModel[]> {
    return this.prisma.withUser(userId, (tx) =>
      tx.account.findMany({ orderBy: { createdAt: 'asc' } }),
    )
  }

  // userId приходит из токена и в теле запроса не принимается: иначе чужой
  // счёт заводится одной строкой, а политика RLS это пропустит — она проверяет
  // принадлежность счёта, а не того, кто его создал.
  async create(userId: string, dto: CreateAccount): Promise<Prisma.AccountModel> {
    try {
      return await this.insert(userId, dto)
    } catch (error) {
      // P2002 — нарушение уникального индекса по (user_id, name), как в
      // регистрации по email. Человеку надо сказать, что имя занято, а не
      // показать пятисотку.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`счёт с названием «${dto.name}» уже есть`)
      }
      throw error
    }
  }

  private insert(userId: string, dto: CreateAccount): Promise<Prisma.AccountModel> {
    return this.prisma.withUser(userId, (tx) =>
      tx.account.create({
        data: {
          userId,
          name: dto.name ?? null,
          provider: dto.provider,
          kind: venueOf(dto.provider),
          baseCurrency: dto.baseCurrency,
          isIis: dto.isIis,
        },
      }),
    )
  }
}
