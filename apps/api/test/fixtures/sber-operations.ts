import type { RawOperation } from '@thesis/contracts'

// Разобранные операции отчёта Сбера. После разделения сервисов api не видит
// XLSX вовсе: файл разбирает ingestor, а сюда приезжают операции. Поэтому и
// фикстура теперь не файл, а их список.
//
// Значения сняты прогоном настоящего парсера на `apps/ingestor/test/fixtures/
// sber-operations.ts` — не придуманы. Если парсер поменяет формат, эти данные
// разойдутся с ним: страхует общий тип `RawOperation` из contracts и тест
// парсера на стороне воркера.
//
// Идентификаторы денежных операций у парсера — sha256 от строки отчёта. Здесь
// они читаемые: api опирается не на их вид, а на их устойчивость и
// различность. Два пополнения одной секунды нарочно имеют разные
// идентификаторы — ровно этим парсер и отличает их друг от друга.

const RUB = 'RUB'

const TRADES: RawOperation[] = [
  {
    kind: 'trade',
    side: 'sell',
    ticker: 'SBER',
    instrumentClass: 'equity',
    quantity: '7',
    price: '268.3',
    // Комиссия у импортированной сделки всегда ноль: в отчёте она отдельной
    // строкой «Движения ДС» и к сделке не привязана.
    fee: '0',
    currency: RUB,
    executedAt: '2026-10-02T08:05:40.000Z',
    externalId: '77004',
  },
  {
    kind: 'trade',
    side: 'buy',
    ticker: 'LKOH',
    instrumentClass: 'equity',
    quantity: '2',
    price: '7250.5',
    fee: '0',
    currency: RUB,
    executedAt: '2026-09-04T13:20:02.000Z',
    externalId: '77003',
  },
  // Две покупки одного дня: порядок внутри дня виден только по времени.
  {
    kind: 'trade',
    side: 'buy',
    ticker: 'SBER',
    instrumentClass: 'equity',
    quantity: '5',
    price: '251',
    fee: '0',
    currency: RUB,
    executedAt: '2026-08-03T09:40:11.000Z',
    externalId: '77002',
  },
  {
    kind: 'trade',
    side: 'buy',
    ticker: 'SBER',
    instrumentClass: 'equity',
    quantity: '10',
    price: '250.5',
    fee: '0',
    currency: RUB,
    executedAt: '2026-08-03T07:15:04.000Z',
    externalId: '77001',
  },
]

const CASH: RawOperation[] = [
  // Два пополнения с совпадающей секундой — вырожденный случай, на котором
  // ключ без порядкового номера склеил бы их в одну операцию.
  {
    kind: 'cash',
    cashKind: 'deposit',
    amount: '1000',
    currency: RUB,
    executedAt: '2026-10-06T06:00:00.000Z',
    externalId: 'deposit-1000-first',
  },
  {
    kind: 'cash',
    cashKind: 'deposit',
    amount: '1000',
    currency: RUB,
    executedAt: '2026-10-06T06:00:00.000Z',
    externalId: 'deposit-1000-second',
  },
  // Комиссия приходит отрицательной суммой: знак в данных, а не в толковании.
  {
    kind: 'cash',
    cashKind: 'fee',
    ticker: 'SBER',
    amount: '-11.28',
    currency: RUB,
    executedAt: '2026-10-05T06:30:00.000Z',
    externalId: 'fee-sber',
  },
  {
    kind: 'cash',
    cashKind: 'dividend',
    ticker: 'SBER',
    amount: '340.2',
    currency: RUB,
    executedAt: '2026-10-05T09:00:00.000Z',
    externalId: 'dividend-sber',
  },
  {
    kind: 'cash',
    cashKind: 'deposit',
    amount: '50000',
    currency: RUB,
    executedAt: '2026-08-01T05:30:00.000Z',
    externalId: 'deposit-50000',
  },
]

// Продажа тикера, покупок которого в отчёте нет: так выглядит выгрузка за
// период, начавшийся позже покупки.
const UNCOVERED_SELL: RawOperation = {
  kind: 'trade',
  side: 'sell',
  ticker: 'GMKN',
  instrumentClass: 'equity',
  quantity: '4',
  price: '130.25',
  fee: '0',
  currency: RUB,
  executedAt: '2026-10-08T07:00:00.000Z',
  externalId: '77006',
}

// Ещё одно пополнение: нужно, когда требуется второй отчёт по тому же счёту —
// иной по содержимому, но такой же валидный.
const EXTRA_DEPOSIT: RawOperation = {
  kind: 'cash',
  cashKind: 'deposit',
  amount: '250',
  currency: RUB,
  executedAt: '2026-10-07T06:00:00.000Z',
  externalId: 'deposit-250',
}

export type SberFixtureOptions = {
  uncoveredSell?: boolean
  extraDeposit?: boolean
}

// Порядок, как у парсера, — от новых к старым: применение обязано отсортировать
// их само, и тест на этом держится.
export function sberOperations(options: SberFixtureOptions = {}): RawOperation[] {
  return [
    ...(options.uncoveredSell ? [UNCOVERED_SELL] : []),
    ...TRADES,
    ...(options.extraDeposit ? [EXTRA_DEPOSIT] : []),
    ...CASH,
  ]
}
