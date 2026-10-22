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
  // Есть отложенные продажи — числа по бумаге неполные.
  incomplete: boolean
  // Последняя известная цена и время биржи. null — цены нет вовсе: такая
  // бумага показывается прочерком и в стоимость портфеля не входит.
  price: string | null
  quotedAt: string | null
  value: string | null
  unrealizedPnl: string | null
}

export type PortfolioTotals = {
  // Стоимость только тех бумаг, по которым есть цена.
  value: string
  unrealizedPnl: string
  realizedPnl: string
  fees: string
  dividends: string
  deposits: string
  // За вычетом всех комиссий, включая уплаченные за ещё не проданные бумаги.
  net: string
}

@Injectable()
export class PortfolioService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(userId: string): Promise<{ rows: PortfolioRow[]; totals: PortfolioTotals }> {
    return this.prisma.withUser(userId, async (tx) => {
      // По бумаге, а не по паре «счёт + бумага»: вопрос звучит «сколько у меня
      // SBER». ИИС и брокерский при этом смешиваются — см. docs/unknowns.md.
      // Свои строки отбирает RLS, справочник инструментов общий.
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
      const prices = new Map(
        (
          await tx.$queryRaw<{ instrumentId: string; price: string; quotedAt: Date }[]>`
            select distinct on (instrument_id)
                   instrument_id as "instrumentId", price::text, quoted_at as "quotedAt"
              from instrument_prices
             order by instrument_id, quoted_at desc
          `
        ).map((row) => [row.instrumentId, row]),
      )

      const zero = Money.of('0')
      // Стоимость и нереализованный результат считаются только там, где цена
      // есть: выдуманная цена хуже прочерка.
      const priced = rows.map((row) => {
        const quote = prices.get(row.instrumentId)
        if (!quote || Money.of(row.quantity).eq(zero)) {
          return {
            ...row,
            price: quote?.price ?? null,
            quotedAt: quote?.quotedAt.toISOString() ?? null,
            value: null,
            unrealizedPnl: null,
          }
        }
        const value = Money.of(row.quantity).times(quote.price)
        return {
          ...row,
          price: quote.price,
          quotedAt: quote.quotedAt.toISOString(),
          value: value.toString(),
          unrealizedPnl: value.minus(row.costBasisTotal).toString(),
        }
      })

      const byKind = new Map(cash.map((entry) => [entry.kind, Money.of(entry.amount)]))
      const realized = rows.reduce((sum, row) => sum.plus(row.realizedPnl), zero)
      const fees = byKind.get('fee') ?? zero
      const value = priced.reduce((sum, row) => (row.value ? sum.plus(row.value) : sum), zero)
      const unrealized = priced.reduce(
        (sum, row) => (row.unrealizedPnl ? sum.plus(row.unrealizedPnl) : sum),
        zero,
      )

      return {
        rows: priced,
        totals: {
          value: value.toString(),
          unrealizedPnl: unrealized.toString(),
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
