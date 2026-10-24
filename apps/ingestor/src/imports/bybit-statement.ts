import { createHash } from 'node:crypto'
import { Money } from '@thesis/contracts'
import { unzipSync } from 'fflate'
import type { RawOperation } from '@thesis/contracts'
import { feeInQuote } from '../connectors/bybit/fee.ts'
import { readCsv } from './csv.ts'

// Выгрузка из кабинета — это архив из нескольких CSV, по кошельку на файл.
// Форматы разные, и разбирать их надо по-разному: см. docs/plans недели 4–6,
// задача 22e.
const UTA = 'AssetChangeDetails_uta'
const OLD_SPOT = 'AssetChangeDetails_spot'
const FUND = 'AssetChangeDetails_fund'
const DEPOSITS = 'assetHistory_withdrawDepositHistory'
const CONTRACT = 'AssetChangeDetails_contract'

// Валюта расчётов спота на Bybit. Пары вида `BTCUSDT`, и справочник
// инструментов хранит именно пару: количество считается в базовой монете.
const QUOTE = 'USDT'

// Стейблкоины — это деньги, а не бумага: их приход идёт взносом, а не лотом.
const STABLES = new Set(['USDT', 'USDC', 'DAI', 'FDUSD'])

export type Skipped = {
  // Производные: позиции с плечом, фондирование, ликвидации. Модели для них
  // нет (решено 24.10.2026), но молчать о них нельзя — в иной год они делают
  // весь результат.
  derivatives: number
  // Новее границы: эти операции уже приехали по API, со своим идентификатором.
  newer: number
  // Вывод монеты из кошелька: остаток на бирже уменьшился, а в журнале для
  // этого нет операции. Запись в docs/unknowns.md.
  withdrawals: number
  // Файл архива, который мы не знаем.
  unknownFiles: string[]
}

export type Statement = { operations: RawOperation[]; skipped: Skipped }

// Ключ идемпотентности. Идентификатора исполнения в выгрузке нет ни в одном
// файле, поэтому он собирается из содержимого — и из номера исполнения внутри
// секунды, иначе два одинаковых добора в одну секунду слиплись бы в одно.
function idOf(parts: (string | number)[]): string {
  return createHash('sha256')
    .update(['bybit-statement', ...parts].join('|'))
    .digest('hex')
}

// Время в файлах — московское? Нет: заголовок говорит Time(UTC), и это UTC.
function atUtc(stamp: string): string {
  return new Date(`${stamp.replace(' ', 'T')}Z`).toISOString()
}

function tickerOf(coin: string): string {
  return `${coin}${QUOTE}`
}

// Все суммы проходят через Money: выгрузка пишет восемнадцать нулей после
// запятой, и в журнале им места нет — а заодно это проверка, что число читается.
function arrival(coin: string, quantity: string, when: string, origin: string): RawOperation {
  return {
    kind: 'arrival',
    ticker: tickerOf(coin),
    instrumentClass: 'crypto',
    quantity: Money.of(quantity).toString(),
    currency: QUOTE,
    executedAt: when,
    externalId: idOf([origin, coin, quantity, when]),
  }
}

function deposit(amount: string, currency: string, when: string, origin: string): RawOperation {
  return {
    kind: 'cash',
    cashKind: 'deposit',
    amount: Money.of(amount).toString(),
    currency,
    executedAt: when,
    externalId: idOf([origin, currency, amount, when]),
  }
}

// --- единый торговый счёт -------------------------------------------------

type Leg = Record<string, string>

// Исполнение спотовое тогда и только тогда, когда среди его строк есть нога в
// базовой монете пары: биржа зачисляет купленную монету. У перпетуала строка
// одна и всегда в валюте залога, а `Quantity` — размер позиции.
function spotTrade(group: Leg[], when: string, index: number): RawOperation | null {
  const contract = group[0]?.Contract ?? ''
  const base = contract.slice(0, -QUOTE.length)
  const baseLeg = group.find((leg) => leg.Currency === base)
  if (!contract.endsWith(QUOTE) || !baseLeg) return null

  const price = group[0]?.['Filled Price'] ?? '0'
  const quantity = Money.of(baseLeg.Quantity ?? '0')
    .abs()
    .toString()
  const feeLeg = group.find((leg) =>
    Money.of(leg['Fee Paid'] ?? '0')
      .abs()
      .gt(Money.of('0')),
  )
  const fee = feeLeg
    ? feeInQuote({
        fee: Money.of(feeLeg['Fee Paid'] ?? '0')
          .abs()
          .toString(),
        feeCurrency: feeLeg.Currency ?? QUOTE,
        symbol: contract,
        price,
        quote: QUOTE,
        what: `выгрузки ${contract} от ${when}`,
      })
    : '0'

  return {
    kind: 'trade',
    side: group[0]?.Direction === 'BUY' ? 'buy' : 'sell',
    ticker: contract,
    instrumentClass: 'crypto',
    quantity,
    price,
    fee,
    currency: QUOTE,
    executedAt: when,
    externalId: idOf([contract, group[0]?.Direction ?? '', price, quantity, when, index]),
  }
}

function parseUta(rows: Leg[], skipped: Skipped, keep: (when: string) => boolean): RawOperation[] {
  const groups = new Map<string, Leg[]>()
  for (const row of rows) {
    if (row.Type !== 'TRADE') {
      // Расчёты по позициям и ликвидации — производные. Переводы между своими
      // кошельками не движение денег, а перекладывание: внешний приход виден в
      // файле депозитов, и считать его дважды нельзя.
      if (row.Type === 'SETTLEMENT' || row.Type === 'LIQUIDATION') skipped.derivatives += 1
      continue
    }
    const key = [row['Time(UTC)'], row.Contract, row.Direction, row['Filled Price']].join('|')
    groups.set(key, [...(groups.get(key) ?? []), row])
  }

  const operations: RawOperation[] = []
  let index = 0
  for (const [, group] of groups) {
    const when = atUtc(group[0]?.['Time(UTC)'] ?? '')
    if (!keep(when)) {
      skipped.newer += group.length
      continue
    }
    const trade = spotTrade(group, when, index)
    index += 1
    if (trade) operations.push(trade)
    else skipped.derivatives += group.length
  }
  return operations
}

// --- старый спотовый кошелёк ----------------------------------------------

// Цены в этом файле нет, и спаривать ноги по времени нельзя: в одну секунду
// проходит несколько исполнений, и наивное спаривание даёт цену в сотню раз
// меньше настоящей. Порядок внутри секунды восстанавливается по остатку
// кошелька: каждая следующая строка считается от предыдущей, поэтому остаток
// монотонен — растёт на приходах и падает на расходах.
function chain(legs: Leg[]): Leg[] {
  const inflow = Money.of(legs[0]?.Amount ?? '0').gt(Money.of('0'))
  return legs.toSorted((a, b) => {
    const left = Money.of(a['Wallet Balance'] ?? '0')
    const right = Money.of(b['Wallet Balance'] ?? '0')
    if (left.eq(right)) return 0
    const ascending = left.lt(right) ? -1 : 1
    return inflow ? ascending : -ascending
  })
}

function parseOldSpot(
  rows: Leg[],
  skipped: Skipped,
  keep: (when: string) => boolean,
): RawOperation[] {
  const operations: RawOperation[] = []
  const byTime = new Map<string, Leg[]>()
  for (const row of rows) {
    const time = row['Time(UTC)'] ?? ''
    byTime.set(time, [...(byTime.get(time) ?? []), row])
  }

  let index = 0
  for (const [time, group] of byTime) {
    const when = atUtc(time)

    for (const row of group) {
      // Приход монеты границу не знает: по API он не приезжает никогда.
      if (row.Type === 'airdropAssetIncrease') {
        operations.push(arrival(row.Coin ?? '', row.Amount ?? '0', when, 'airdrop'))
      }
      // Внутренние переводы между своими кошельками в журнал не попадают.
    }

    const trades = group.filter((row) => row.Type === 'trade')
    if (trades.length === 0) continue
    if (!keep(when)) {
      skipped.newer += trades.length
      continue
    }

    const fees = new Map<string, string>()
    for (const row of group.filter((item) => item.Type === 'tradingFee')) {
      fees.set(
        row.Coin ?? '',
        Money.of(row.Amount ?? '0')
          .abs()
          .toString(),
      )
    }

    const quoteLegs = chain(trades.filter((row) => row.Coin === QUOTE))
    const baseLegs = chain(trades.filter((row) => row.Coin !== QUOTE))
    if (quoteLegs.length !== baseLegs.length) {
      throw new Error(`выгрузка ${time}: ног ${baseLegs.length} против ${quoteLegs.length} в USDT`)
    }

    for (const [i, baseLeg] of baseLegs.entries()) {
      const quoteLeg = quoteLegs[i]!
      const coin = baseLeg.Coin ?? ''
      const quantity = Money.of(baseLeg.Amount ?? '0').abs()
      const paid = Money.of(quoteLeg.Amount ?? '0').abs()
      // Цена выводится делением ног: оба числа посчитала биржа, их отношение и
      // есть цена исполнения. Проверка верного спаривания встроенная — у
      // исполнений одной заявки цена обязана совпасть.
      const price = paid.div(quantity).toString()
      const buy = Money.of(baseLeg.Amount ?? '0').gt(Money.of('0'))
      const feeCoin = buy ? coin : QUOTE

      operations.push({
        kind: 'trade',
        side: buy ? 'buy' : 'sell',
        ticker: tickerOf(coin),
        instrumentClass: 'crypto',
        quantity: quantity.toString(),
        price,
        fee: feeInQuote({
          fee: fees.get(feeCoin) ?? '0',
          feeCurrency: feeCoin,
          symbol: tickerOf(coin),
          price,
          quote: QUOTE,
          what: `выгрузки ${coin} от ${time}`,
        }),
        currency: QUOTE,
        executedAt: when,
        externalId: idOf([
          tickerOf(coin),
          buy ? 'buy' : 'sell',
          price,
          quantity.toString(),
          when,
          index,
        ]),
      })
      index += 1
    }
  }
  return operations
}

// --- финансовый кошелёк и депозиты ----------------------------------------

function parseFund(rows: Leg[]): RawOperation[] {
  const operations: RawOperation[] = []
  for (const row of rows) {
    // Переводы между своими кошельками и приходы из сети здесь только
    // отражаются: первые не движение денег, вторые приедут файлом депозитов.
    if (row.Type !== 'Fiat') continue
    operations.push(
      deposit(row.QTY ?? '0', row.Coin ?? QUOTE, atUtc(row['Date & Time(UTC)'] ?? ''), 'fiat'),
    )
  }
  return operations
}

function parseDeposits(rows: Leg[], skipped: Skipped): RawOperation[] {
  const operations: RawOperation[] = []
  for (const row of rows) {
    const when = atUtc(row.Date ?? '')
    const asset = row.Asset ?? ''
    if (row.Type === 'Withdraw') {
      // Вывод стейблкоина — это деньги со счёта, он учитывается. Вывод монеты
      // уменьшает остаток, а операции «списать лот без продажи» в журнале нет.
      if (STABLES.has(asset)) {
        operations.push({
          kind: 'cash',
          cashKind: 'deposit',
          amount: Money.of(row.Amount ?? '0')
            .negated()
            .toString(),
          currency: asset,
          executedAt: when,
          externalId: idOf(['withdraw', asset, row['Tx ID'] ?? '', when]),
        })
      } else skipped.withdrawals += 1
      continue
    }

    if (STABLES.has(asset)) {
      operations.push(deposit(row.Amount ?? '0', asset, when, 'deposit'))
    } else {
      operations.push(arrival(asset, row.Amount ?? '0', when, 'deposit'))
    }
  }
  return operations
}

// --- архив ----------------------------------------------------------------

export function parseBybitStatement(archive: Buffer, cutoff?: Date): Statement {
  const files = unzipSync(new Uint8Array(archive))
  const skipped: Skipped = { derivatives: 0, newer: 0, withdrawals: 0, unknownFiles: [] }
  // Граница по дате действует **только на сделки**: это они приезжают по API
  // со своим `execId`, и только их можно задвоить. Депозиты, airdrop'ы, P2P и
  // переводы API не отдаёт ни в каком окне — отбросив их по дате, мы потеряли
  // бы единственный источник себестоимости для монет, пришедших не покупкой.
  // Проверено на живой выгрузке: с границей на всё BTC-депозиты пропадали.
  const keep = (when: string) => !cutoff || new Date(when) < cutoff

  const operations: RawOperation[] = []
  for (const [path, bytes] of Object.entries(files)) {
    const name = path.split('/').pop() ?? path
    if (!name.endsWith('.csv')) continue
    // Первая строка — подпись с UID, заголовок на второй.
    const rows = readCsv(new TextDecoder().decode(bytes), 1)

    if (name.startsWith(UTA)) operations.push(...parseUta(rows, skipped, keep))
    else if (name.startsWith(OLD_SPOT)) operations.push(...parseOldSpot(rows, skipped, keep))
    else if (name.startsWith(FUND)) operations.push(...parseFund(rows))
    else if (name.startsWith(DEPOSITS)) operations.push(...parseDeposits(rows, skipped))
    else if (name.startsWith(CONTRACT)) skipped.derivatives += rows.length
    else skipped.unknownFiles.push(name)
  }

  // По возрастанию времени: применение идёт по порядку, иначе продажа может
  // встретиться раньше своей покупки и уехать в отложенные без причины.
  return {
    operations: operations.toSorted((a, b) => a.executedAt.localeCompare(b.executedAt)),
    skipped,
  }
}
