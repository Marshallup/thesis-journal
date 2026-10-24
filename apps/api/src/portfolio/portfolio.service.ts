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
  // Итог по бумаге: реализованное, нереализованное и её комиссии вместе.
  // null — есть остаток, но нет цены: итог неизвестен.
  totalPnl: string | null
}

// Счёт целиком: своё имя, своя валюта и свой итог. Нужен потому, что счетов
// бывает несколько — брокерский, ИИС, крипта, тренажёр, — и складывать их в
// одно число можно не всегда.
export type PortfolioAccount = {
  accountId: string
  name: string | null
  provider: string
  kind: string
  baseCurrency: string
  isIis: boolean
  createdAt: string
  realizedPnl: string
  unrealizedPnl: string
  fees: string
  dividends: string
  totalPnl: string
  // Сколько открытых позиций счёта остались без цены. Ноль в
  // `unrealizedPnl` при непустом счётчике значит «неизвестно», а не «нисколько»:
  // без этого числа экран показывал бы ноль там, где цены просто нет.
  unpricedPositions: number
  // Часть реализованного, которая пришла от монет без себестоимости: депозит,
  // airdrop, конвертация. Журнал считает их бесплатными, поэтому прибыль по
  // ним завышена на всю стоимость монеты — и это обязано быть видно, иначе
  // число на экране выглядит заработком, которым не является.
  realizedWithoutCost: string
}

// Итог на валюту, а не один на всё: доллар к рублю без курса не прибавить, а
// конвертации в проекте пока нет вовсе.
export type PortfolioCurrencyTotal = {
  currency: string
  totalPnl: string
  // В валюте есть счёт с позициями без цены — значит итог неполон.
  incomplete: boolean
}

export type PortfolioTotals = {
  // Стоимость только тех бумаг, по которым есть цена.
  value: string
  unrealizedPnl: string
  realizedPnl: string
  fees: string
  dividends: string
  deposits: string
}

@Injectable()
export class PortfolioService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(userId: string): Promise<{
    rows: PortfolioRow[]
    accounts: PortfolioAccount[]
    byCurrency: PortfolioCurrencyTotal[]
    totals: PortfolioTotals
  }> {
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

      // Деньги в разрезе счёта и вида: из этих же строк складываются и общие
      // суммы, чтобы «комиссии» на двух экранах не разъехались.
      const cash = await tx.$queryRaw<{ accountId: string; kind: string; amount: string }[]>`
        select account_id as "accountId", kind, sum(amount)::text as amount
          from cash_ledger
         group by account_id, kind
      `

      const accounts = await tx.$queryRaw<
        Omit<
          PortfolioAccount,
          'realizedPnl' | 'unrealizedPnl' | 'fees' | 'dividends' | 'totalPnl'
        >[]
      >`
        select id as "accountId",
               name,
               provider,
               kind,
               base_currency as "baseCurrency",
               is_iis as "isIis",
               created_at as "createdAt"
          from accounts
         order by created_at
      `

      // Позиции в разрезе счёта. Цены присоединяются ниже, в TypeScript, как и
      // в строках по бумагам: «цены нет» должно значить одно и то же везде.
      const positions = await tx.$queryRaw<
        {
          accountId: string
          instrumentId: string
          quantity: string
          costBasisTotal: string
          realizedPnl: string
        }[]
      >`
        select account_id as "accountId",
               instrument_id as "instrumentId",
               quantity::text,
               cost_basis_total::text as "costBasisTotal",
               realized_pnl::text as "realizedPnl"
          from positions
      `
      // Реализованное по лотам, у которых себестоимости нет. Считается по
      // расходам лотов, а не по сделкам: продажа могла съесть и нулевой лот, и
      // настоящую покупку — разделить это можно только здесь.
      const withoutCost = new Map(
        (
          await tx.$queryRaw<{ accountId: string; realized: string }[]>`
            select c.account_id as "accountId", sum(c.realized_pnl)::text as realized
              from lot_consumptions c
              join lots l on l.id = c.lot_id
              join trades t on t.id = l.open_trade_id
             where t.cost_unknown
             group by c.account_id
          `
        ).map((row) => [row.accountId, row.realized]),
      )

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
        const closed = Money.of(row.quantity).eq(zero)
        if (!quote || closed) {
          return {
            ...row,
            price: quote?.price ?? null,
            quotedAt: quote?.quotedAt.toISOString() ?? null,
            value: null,
            unrealizedPnl: null,
            // Позиция закрыта — итог полон и без цены: оценивать нечего.
            // Остаток есть, а цены нет — итога не существует, прочерк честнее.
            totalPnl: closed ? Money.of(row.realizedPnl).plus(row.fees).toString() : null,
          }
        }
        const value = Money.of(row.quantity).times(quote.price)
        const unrealized = value.minus(row.costBasisTotal)
        return {
          ...row,
          price: quote.price,
          quotedAt: quote.quotedAt.toISOString(),
          value: value.toString(),
          unrealizedPnl: unrealized.toString(),
          // Комиссия складывается, а не вычитается: в cash_ledger она лежит
          // отрицательной суммой — тем же знаком, каким ушла со счёта.
          totalPnl: Money.of(row.realizedPnl).plus(unrealized).plus(row.fees).toString(),
        }
      })

      const money = (entry: { amount: string } | undefined) =>
        entry ? Money.of(entry.amount) : zero
      const byKind = new Map<string, Money>()
      for (const entry of cash) {
        byKind.set(entry.kind, (byKind.get(entry.kind) ?? zero).plus(entry.amount))
      }
      const realized = rows.reduce((sum, row) => sum.plus(row.realizedPnl), zero)
      // Все комиссии счёта, а не только привязанные к бумагам: депозитарную
      // тоже заплатили.
      const fees = byKind.get('fee') ?? zero
      const dividends = byKind.get('dividend') ?? zero
      const value = priced.reduce((sum, row) => (row.value ? sum.plus(row.value) : sum), zero)
      const unrealized = priced.reduce(
        (sum, row) => (row.unrealizedPnl ? sum.plus(row.unrealizedPnl) : sum),
        zero,
      )

      const byAccount = accounts.map((account) => {
        let realizedOf = zero
        let unrealizedOf = zero
        let unpriced = 0
        for (const position of positions) {
          if (position.accountId !== account.accountId) continue
          realizedOf = realizedOf.plus(position.realizedPnl)
          const quote = prices.get(position.instrumentId)
          const closed = Money.of(position.quantity).eq(zero)
          // Бумага без цены в нереализованное не входит — ровно как в строках
          // по бумагам: выдуманная цена хуже отсутствующей. Но молчать об этом
          // нельзя: иначе ноль читается как «нереализованного нет».
          if (!closed && !quote) unpriced += 1
          if (!quote || closed) continue
          unrealizedOf = unrealizedOf.plus(
            Money.of(position.quantity).times(quote.price).minus(position.costBasisTotal),
          )
        }
        const feesOf = money(
          cash.find((entry) => entry.accountId === account.accountId && entry.kind === 'fee'),
        )
        const dividendsOf = money(
          cash.find((entry) => entry.accountId === account.accountId && entry.kind === 'dividend'),
        )
        return {
          ...account,
          createdAt: new Date(account.createdAt).toISOString(),
          realizedPnl: realizedOf.toString(),
          unrealizedPnl: unrealizedOf.toString(),
          fees: feesOf.toString(),
          dividends: dividendsOf.toString(),
          totalPnl: realizedOf.plus(unrealizedOf).plus(feesOf).plus(dividendsOf).toString(),
          unpricedPositions: unpriced,
          realizedWithoutCost: Money.of(withoutCost.get(account.accountId) ?? '0').toString(),
        }
      })

      const perCurrency = new Map<string, Money>()
      const incompleteCurrencies = new Set<string>()
      for (const account of byAccount) {
        // Бумажный счёт в итог не входит: воображаемая торговля не смешивается
        // с настоящими деньгами. В строке он остаётся и помечен.
        if (account.kind === 'paper') continue
        perCurrency.set(
          account.baseCurrency,
          (perCurrency.get(account.baseCurrency) ?? zero).plus(account.totalPnl),
        )
        if (account.unpricedPositions > 0) incompleteCurrencies.add(account.baseCurrency)
      }

      return {
        rows: priced,
        accounts: byAccount,
        byCurrency: [...perCurrency].map(([currency, total]) => ({
          currency,
          totalPnl: total.toString(),
          incomplete: incompleteCurrencies.has(currency),
        })),
        totals: {
          value: value.toString(),
          unrealizedPnl: unrealized.toString(),
          realizedPnl: realized.toString(),
          fees: fees.toString(),
          dividends: dividends.toString(),
          deposits: (byKind.get('deposit') ?? zero).toString(),
        },
      }
    })
  }
}
