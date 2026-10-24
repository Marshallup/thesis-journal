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

const ZERO = Money.of('0')

export type Skipped = {
  // Производные: позиции с плечом, фондирование, ликвидации. Модели для них
  // нет (решено 24.10.2026), но молчать о них нельзя — в иной год они делают
  // весь результат.
  derivatives: number
  // Сколько монет выведено с биржи. Теперь они становятся выбытием, а не
  // пропадают, но число остаётся: человеку полезно видеть, что часть движения
  // портфеля — не торговля, а переводы.
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
// Вывод монеты: лоты списываются, как при продаже, а цена берётся по рынку на
// момент вывода. Без этого монета остаётся в журнале навсегда — остаток не
// сойдётся с биржей, а убыток от вывода обесценившейся монеты не увидит никто.
function disposal(coin: string, quantity: string, when: string, origin: string): RawOperation {
  return {
    kind: 'disposal',
    ticker: tickerOf(coin),
    instrumentClass: 'crypto',
    quantity: Money.of(quantity).abs().toString(),
    currency: QUOTE,
    executedAt: when,
    externalId: idOf([origin, coin, quantity, when]),
  }
}

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
//
// Ног в монете может быть несколько: заявка дробится на исполнения, и все они
// попадают в одну группу — одно время, одна цена, одно направление. Каждое
// остаётся **отдельной сделкой**, а не складывается в одну: по API эти же
// исполнения приедут по одному, и сверка по содержимому должна совпадать
// строка в строку. Найдено на живой выгрузке: заявка по XRP разбита на девять
// частей, и прежний разборщик брал из неё только первую.
function spotTrades(group: Leg[], when: string, from: number): RawOperation[] {
  const contract = group[0]?.Contract ?? ''
  const base = contract.slice(0, -QUOTE.length)
  if (!contract.endsWith(QUOTE)) return []

  const baseLegs = group.filter((leg) => leg.Currency === base)
  if (baseLegs.length === 0) return []

  // Цена через Money: выгрузка пишет восемь нулей после запятой, а сверка по
  // содержимому сравнивает строки — и «10.00000000» не должно отличаться от «10».
  const price = Money.of(group[0]?.['Filled Price'] ?? '0').toString()
  const side = group[0]?.Direction === 'BUY' ? 'buy' : 'sell'

  return baseLegs.map((leg, i) => {
    const quantity = Money.of(leg.Quantity ?? '0')
      .abs()
      .toString()
    // Комиссия своя у каждого исполнения: при покупке она списана купленной
    // монетой с этой же строки, при продаже — вырученным USDT с ноги оплаты.
    const feeLeg = Money.of(leg['Fee Paid'] ?? '0')
      .abs()
      .gt(ZERO)
      ? leg
      : group.find(
          (other) =>
            other.Currency === QUOTE &&
            Money.of(other['Fee Paid'] ?? '0')
              .abs()
              .gt(ZERO),
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
      side,
      ticker: contract,
      instrumentClass: 'crypto',
      quantity,
      price,
      fee,
      currency: QUOTE,
      executedAt: when,
      externalId: idOf([contract, side, price, quantity, when, from + i]),
    } satisfies RawOperation
  })
}

function parseUta(rows: Leg[], skipped: Skipped): RawOperation[] {
  const groups = new Map<string, Leg[]>()
  const arrivals: RawOperation[] = []

  for (const row of rows) {
    if (row.Type !== 'TRADE') {
      // Расчёты по позициям и ликвидации — производные. Переводы между своими
      // кошельками не движение денег, а перекладывание: внешний приход виден в
      // файле депозитов, и считать его дважды нельзя.
      if (row.Type === 'SETTLEMENT' || row.Type === 'LIQUIDATION') skipped.derivatives += 1
      else if (row.Type !== 'TRANSFER_IN' && row.Type !== 'TRANSFER_OUT') {
        // Тип, которого мы не знаем: конвертация токена, ребрендинг, промо.
        // Прибавилась монета — это приход без себестоимости, убыла — вывод.
        // Поймано на живой выгрузке: 146 956 токенов появились строкой с типом
        // «--», разборщик их потерял, и продажа повисла отложенной навсегда,
        // потому что покупки у неё нет и не было.
        const coin = row.Currency ?? ''
        const change = Money.of(row['Cash Flow'] || '0')
        if (!STABLES.has(coin) && !change.eq(ZERO)) {
          const when = atUtc(row['Time(UTC)'] ?? '')
          if (change.gt(ZERO)) {
            arrivals.push(arrival(coin, change.toString(), when, row.Type ?? ''))
          } else {
            // Монета убыла строкой незнакомого типа — конвертация в другой
            // токен, списание площадкой. Выбытие, а не молчание.
            arrivals.push(disposal(coin, change.toString(), when, row.Type ?? ''))
            skipped.withdrawals += 1
          }
        }
      }
      continue
    }
    const key = [row['Time(UTC)'], row.Contract, row.Direction, row['Filled Price']].join('|')
    groups.set(key, [...(groups.get(key) ?? []), row])
  }

  const operations: RawOperation[] = [...arrivals]
  let index = 0
  for (const [, group] of groups) {
    const when = atUtc(group[0]?.['Time(UTC)'] ?? '')
    const trades = spotTrades(group, when, index)
    index += trades.length
    if (trades.length > 0) operations.push(...trades)
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

function parseOldSpot(rows: Leg[]): RawOperation[] {
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
      } else {
        operations.push(disposal(asset, row.Amount ?? '0', when, `withdraw:${row['Tx ID'] ?? ''}`))
        skipped.withdrawals += 1
      }
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

// Границы по дате здесь больше нет, и это снятое ограничение, а не упрощение.
// Она защищала от задвоения с сделками, приехавшими по API, но защищала только
// при правильном порядке загрузки: сначала ключ, потом файлы. Порядок, от
// которого зависит правильность денег, — это баг, а не инструкция. Теперь
// задвоение ловит сверка по содержимому в `api`, с учётом кратности: см.
// `apply-import.service.ts`. Решено 24.10.2026.
export function parseBybitStatement(archive: Buffer): Statement {
  const files = unzipSync(new Uint8Array(archive))
  const skipped: Skipped = { derivatives: 0, withdrawals: 0, unknownFiles: [] }

  const operations: RawOperation[] = []
  for (const [path, bytes] of Object.entries(files)) {
    const name = path.split('/').pop() ?? path
    if (!name.endsWith('.csv')) continue
    // Первая строка — подпись с UID, заголовок на второй.
    const rows = readCsv(new TextDecoder().decode(bytes), 1)

    if (name.startsWith(UTA)) operations.push(...parseUta(rows, skipped))
    else if (name.startsWith(OLD_SPOT)) operations.push(...parseOldSpot(rows))
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
