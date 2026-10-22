import { createHash } from 'node:crypto'
import { Money } from '@thesis/contracts'
import readXlsxFile from 'read-excel-file/node'

type CashKind = 'dividend' | 'coupon' | 'tax' | 'deposit' | 'fee'

// Инструмент уникален по паре (symbol, class) — без класса не найти его id.
export type InstrumentClass = 'equity' | 'bond' | 'etf' | 'crypto' | 'currency'

export type RawOperation = {
  kind: 'trade' | 'cash'
  side?: 'buy' | 'sell'
  ticker?: string
  instrumentClass?: InstrumentClass
  quantity?: string
  price?: string
  fee?: string
  currency: string
  amount?: string
  cashKind?: CashKind
  executedAt: string
  externalId: string
}

// Значение ячейки после разбора: число приходит сырой строкой, см. RAW_NUMBERS.
type Cell = string | boolean | Date | null
type Sheet = { rows: Cell[][]; cell: (row: Cell[], column: string) => Cell }

const TRADES_SHEET = 'Сделки'
const CASH_SHEET = 'Движение ДС'

// Число ячейки забираем строкой из XML: иначе деньги побывали бы float
// ещё до первой нашей строчки.
const RAW_NUMBERS = { parseNumber: (value: string): string => value }

const SIDES: Record<string, 'buy' | 'sell'> = { Покупка: 'buy', Продажа: 'sell' }

// В выгрузке за год встретилось одно значение. Угадывать остальные нельзя:
// неверный класс молча разведёт одну бумагу на два инструмента.
const INSTRUMENT_CLASSES: Record<string, InstrumentClass> = { Акция: 'equity' }

// Названия сняты с выгрузки. Знак наш: в файле сумма всегда положительная,
// а сумма ledger должна сходиться с балансом.
const CASH_KINDS: Record<string, { cashKind: CashKind; outgoing: boolean }> = {
  'Пополнение счёта': { cashKind: 'deposit', outgoing: false },
  'Выплата дивидендов': { cashKind: 'dividend', outgoing: false },
  Комиссия: { cashKind: 'fee', outgoing: true },
}

// Копейка — округление, больше — облигация (цена в процентах от номинала),
// лот не в одну бумагу или съехавшая колонка.
const VOLUME_TOLERANCE = '0.01'

// Статус встретился ровно один. Незнакомый пропускать нельзя: неизвестно,
// двинулись деньги или нет.
const EXECUTED = 'Исполнена'

const MOSCOW = 'Europe/Moscow'
const moscowClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: MOSCOW,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

// Через Intl, а не «плюс три часа»: в выгрузке за 2013-й смещение другое.
// На вход — целая секунда (это обеспечивает wallClock), иначе остаток
// миллисекунд уехал бы в смещение.
function moscowShiftMs(instant: number): number {
  const parts = new Map(moscowClock.formatToParts(new Date(instant)).map((p) => [p.type, p.value]))
  const at = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.get(type))
  const wall = Date.UTC(
    at('year'),
    at('month') - 1,
    at('day'),
    at('hour') % 24,
    at('minute'),
    at('second'),
  )
  return wall - instant
}

// Стенные часы Москвы → момент в UTC. Смещение берётся дважды: иначе в сутки
// перевода часов время уезжает на час.
function moscowWallToUtc(wall: number): string {
  const shift = moscowShiftMs(wall - moscowShiftMs(wall))
  return new Date(wall - shift).toISOString()
}

// UTC-поля Date несут стенные часы файла, а не момент в UTC. Пересчёт идёт
// float-арифметикой с floor, поэтому секунда приходит на миллисекунду короче —
// округляем обратно.
function wallClock(value: Cell, column: string): number {
  if (value instanceof Date) return Math.round(value.getTime() / 1000) * 1000
  throw new Error(`колонка «${column}»: ожидалась дата, пришло ${JSON.stringify(value)}`)
}

function amountOf(value: Cell, column: string): Money {
  // Колонка, выгруженная текстом, приходит как «1 234,56».
  if (typeof value === 'string' && value.trim()) {
    return Money.of(value.replaceAll(/\s/gu, '').replace(',', '.'))
  }
  throw new Error(`колонка «${column}»: ожидалось число, пришло ${JSON.stringify(value)}`)
}

function text(value: Cell): string {
  return value == null ? '' : String(value).trim()
}

// По названию, а не по позиции: порядок колонок между версиями плавает.
function sheetOf(sheets: Map<string, Cell[][]>, name: string): Sheet {
  const data = sheets.get(name)
  if (!data) throw new Error(`в файле нет листа «${name}» — это не выгрузка операций Сбера`)

  const columns = new Map((data[0] ?? []).map((title, position) => [text(title), position]))

  return {
    // Первая строка — шапка.
    rows: data.slice(1),
    cell: (row, column) => {
      const position = columns.get(column)
      if (position === undefined) throw new Error(`лист «${name}»: нет колонки «${column}»`)
      return row[position] ?? null
    },
  }
}

// «Объем сделки» — единственный способ проверить цену и количество, не выходя
// из файла. Расхождение означает неверную себестоимость.
function checkVolume(externalId: string, product: Money, volume: Money): void {
  const drift = product.minus(volume)
  const magnitude = drift.isNegative() ? Money.of('0').minus(drift) : drift
  if (magnitude.lt(VOLUME_TOLERANCE)) return

  throw new Error(
    `лист «${TRADES_SHEET}», сделка ${externalId}: количество × цена не сходится с объёмом ` +
      `(${product.toString()} против ${volume.toString()}) — цена значит не то, что ожидает парсер`,
  )
}

function parseTrades({ rows, cell }: Sheet): RawOperation[] {
  return rows.flatMap((row) => {
    const externalId = text(cell(row, 'Номер сделки'))
    if (!externalId) return []

    const operation = text(cell(row, 'Операция'))
    const side = SIDES[operation]
    if (!side) throw new Error(`лист «${TRADES_SHEET}»: неизвестная операция «${operation}»`)

    const quantity = amountOf(cell(row, 'Количество'), 'Количество')
    const price = amountOf(cell(row, 'Цена'), 'Цена')
    checkVolume(
      externalId,
      quantity.times(price),
      amountOf(cell(row, 'Объем сделки'), 'Объем сделки'),
    )

    const instrumentType = text(cell(row, 'Тип финансового инструмента'))
    const instrumentClass = INSTRUMENT_CLASSES[instrumentType]
    if (!instrumentClass) {
      throw new Error(`лист «${TRADES_SHEET}»: неизвестный тип инструмента «${instrumentType}»`)
    }

    return [
      {
        kind: 'trade' as const,
        side,
        ticker: text(cell(row, 'Код финансового инструмента')),
        instrumentClass,
        quantity: quantity.toString(),
        price: price.toString(),
        // Комиссия в листе сделок отсутствует и к сделке не привязывается:
        // она приходит отдельными строками в «Движении ДС». Разбор —
        // docs/unknowns.md, «Комиссия сделки не попадает в себестоимость лота».
        fee: '0',
        currency: text(cell(row, 'Валюта')),
        executedAt: moscowWallToUtc(wallClock(cell(row, 'Дата заключения'), 'Дата заключения')),
        externalId,
      },
    ]
  })
}

function parseCash({ rows, cell }: Sheet): RawOperation[] {
  // Своего идентификатора у денежной операции нет, поэтому ключ — хеш набора
  // полей. occurrence считается среди одинаковых по этому набору строк: без
  // него два совпавших до секунды пополнения склеятся в одно, а по абсолютному
  // номеру строки повторный импорт задвоил бы всё после вставки строки выше.
  const occurrences = new Map<string, number>()

  return rows.flatMap((row) => {
    const operation = text(cell(row, 'Операция'))
    if (!operation) return []

    const status = text(cell(row, 'Статус'))
    if (status !== EXECUTED) {
      throw new Error(`лист «${CASH_SHEET}»: неизвестный статус «${status}» у «${operation}»`)
    }

    const known = CASH_KINDS[operation]
    if (!known) throw new Error(`лист «${CASH_SHEET}»: неизвестная операция «${operation}»`)

    const currency = text(cell(row, 'Валюта операции'))
    const magnitude = amountOf(cell(row, 'Сумма'), 'Сумма')
    const amount = known.outgoing ? Money.of('0').minus(magnitude) : magnitude
    const executedAt = moscowWallToUtc(
      wallClock(cell(row, 'Дата исполнения поручения'), 'Дата исполнения поручения'),
    )
    const ticker = text(cell(row, 'Код финансового инструмента'))

    const identity = [
      text(cell(row, 'Номер договора')),
      executedAt,
      operation,
      amount.toString(),
      currency,
    ]
    const base = identity.join('|')
    const occurrence = (occurrences.get(base) ?? 0) + 1
    occurrences.set(base, occurrence)

    return [
      {
        kind: 'cash' as const,
        cashKind: known.cashKind,
        amount: amount.toString(),
        currency,
        executedAt,
        externalId: createHash('sha256').update(`${base}|${occurrence}`).digest('hex'),
        ...(ticker ? { ticker } : {}),
      },
    ]
  })
}

export async function parseSberXlsx(file: Buffer): Promise<RawOperation[]> {
  // Все листы за один проход: readSheet распаковывал бы zip на каждый.
  // Приведение — из-за опечатки в типах библиотеки (`typeof Date`).
  const read = await readXlsxFile<string>(file, RAW_NUMBERS)
  const sheets = new Map(read.map((s) => [s.sheet, s.data as unknown as Cell[][]]))

  return [...parseTrades(sheetOf(sheets, TRADES_SHEET)), ...parseCash(sheetOf(sheets, CASH_SHEET))]
}
