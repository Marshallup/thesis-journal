import { Injectable } from '@nestjs/common'
import { Money } from '@thesis/contracts'
import { PrismaService } from '../db/prisma.service.ts'

export type PortfolioRow = {
  instrumentId: string
  symbol: string
  quantity: string
  costBasisTotal: string
  // null, когда бумага продана полностью: делить затраты не на что.
  averagePrice: string | null
  realizedPnl: string
  fees: string
  // true, если по бумаге есть отложенные продажи: числа по ней заведомо
  // неполные, и показывать их как итог нельзя.
  incomplete: boolean
}

export type PortfolioTotals = {
  realizedPnl: string
  fees: string
  dividends: string
  deposits: string
  // Реализованный результат за вычетом всех комиссий. Приблизительный:
  // комиссии покупок по открытым позициям тоже здесь, хотя относятся к
  // будущему результату, а не к прошлому.
  net: string
}

@Injectable()
export class PortfolioService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(userId: string): Promise<{ rows: PortfolioRow[]; totals: PortfolioTotals }> {
    return this.prisma.withUser(userId, async (tx) => {
      // Суммируем по бумаге, а не по паре «счёт + бумага»: человек спрашивает
      // «сколько у меня SBER», а не «сколько на каждом из счетов». Налоговые
      // режимы ИИС и брокерского при этом смешиваются — см. docs/unknowns.md.
      //
      // RLS отфильтрует positions, cash_ledger и deferred_operations сама:
      // справочник инструментов общий, остальное — только своё.
      const rows = await tx.$queryRaw<PortfolioRow[]>`
        with involved as (
          -- Бумага с одной лишь отложенной продажей позиции не имеет, но
          -- попасть в список обязана: именно про неё и нужно знать, что
          -- картина неполная.
          select instrument_id from positions
          union
          select instrument_id from deferred_operations
        )
        select i.id as "instrumentId",
               i.symbol,
               coalesce(sum(p.quantity), 0)::text as quantity,
               coalesce(sum(p.cost_basis_total), 0)::text as "costBasisTotal",
               case when coalesce(sum(p.quantity), 0) <> 0
                    then round(sum(p.cost_basis_total) / sum(p.quantity), 8)::text
               end as "averagePrice",
               coalesce(sum(p.realized_pnl), 0)::text as "realizedPnl",
               coalesce((
                 select sum(c.amount) from cash_ledger c
                  where c.instrument_id = i.id and c.kind = 'fee'
               ), 0)::text as fees,
               exists (
                 select 1 from deferred_operations o where o.instrument_id = i.id
               ) as incomplete
          from involved v
          join instruments i on i.id = v.instrument_id
          left join positions p on p.instrument_id = i.id
         group by i.id, i.symbol
         order by i.symbol
      `

      const cash = await tx.$queryRaw<{ kind: string; amount: string }[]>`
        select kind, sum(amount)::text as amount from cash_ledger group by kind
      `
      const byKind = new Map(cash.map((entry) => [entry.kind, Money.of(entry.amount)]))
      const zero = Money.of('0')
      const realized = rows.reduce((sum, row) => sum.plus(row.realizedPnl), zero)
      const fees = byKind.get('fee') ?? zero

      return {
        rows,
        totals: {
          realizedPnl: realized.toString(),
          fees: fees.toString(),
          dividends: (byKind.get('dividend') ?? zero).toString(),
          deposits: (byKind.get('deposit') ?? zero).toString(),
          net: realized.plus(fees).toString(),
        },
      }
    })
  }
}
