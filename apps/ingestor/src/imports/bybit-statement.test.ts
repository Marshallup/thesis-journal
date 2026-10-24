import { expect, it } from 'vitest'
import { archiveWithUnknownFile, statementArchive } from '../../test/fixtures/bybit-statement.ts'
import { parseBybitStatement } from './bybit-statement.ts'

const statement = () => parseBybitStatement(statementArchive())

function trades(result = statement()) {
  return result.operations.filter((operation) => operation.kind === 'trade')
}

// Цена в файле единого счёта записана как есть, выводить её не надо. Комиссия
// взята купленной монетой — её нужно привести к валюте сделки, иначе в
// себестоимость лота попадёт сложение TIA с USDT.
it('спотовая покупка берёт цену из строки, комиссию приводит к валюте сделки', () => {
  const buy = trades().find((operation) => operation.executedAt.startsWith('2024-03-02'))

  expect(buy).toMatchObject({
    side: 'buy',
    ticker: 'TIAUSDT',
    instrumentClass: 'crypto',
    quantity: '12.5',
    price: '8.00000000',
    currency: 'USDT',
    // 0.0125 TIA × 8 = 0.1 USDT
    fee: '0.1',
  })
})

it('спотовая продажа берёт комиссию как есть: она уже в валюте сделки', () => {
  const sell = trades().find((operation) => operation.executedAt.startsWith('2024-03-05'))

  expect(sell).toMatchObject({ side: 'sell', quantity: '7.5', price: '9.00000000', fee: '0.0675' })
})

// Главное отличие: у перпетуала нет ноги в самой монете. Ни он, ни расчёты, ни
// ликвидации не должны стать сделками — и о них надо сказать, а не промолчать.
it('перпетуалы, расчёты и ликвидации не становятся сделками, но посчитаны', () => {
  const result = statement()

  expect(trades(result).map((operation) => operation.ticker)).toEqual([
    'NEARUSDT',
    'NEARUSDT',
    'NEARUSDT',
    'TIAUSDT',
    'TIAUSDT',
  ])
  // Строка перпетуала, расчёт и ликвидация — три штуки.
  expect(result.skipped.derivatives).toBe(3)
})

// Ловушка старого кошелька: два исполнения в одну секунду. Спаривание по
// времени дало бы цену вдесятеро меньше, спаривание по цепочке остатков даёт
// одинаковую цену у обоих — это и есть встроенная проверка.
it('два исполнения в одну секунду дают одну и ту же выведенную цену', () => {
  const same = trades()
    .filter((operation) => operation.executedAt.startsWith('2024-02-01'))
    .map((operation) => operation.price)

  expect(same).toEqual(['10', '10'])
})

it('в старом кошельке цена выводится делением ног, а комиссия — из своей строки', () => {
  const sell = trades().find((operation) => operation.executedAt.startsWith('2024-02-03'))

  expect(sell).toMatchObject({ side: 'sell', ticker: 'NEARUSDT', quantity: '4', price: '11' })
  expect(sell?.fee).toBe('0.044')
})

// Монета, пришедшая не сделкой: депозит из сети и airdrop. Себестоимости у
// неё нет, и лот будет нулевым с пометкой — решено 24.10.2026.
it('депозит монеты и airdrop становятся приходом без цены', () => {
  const arrivals = statement().operations.filter((operation) => operation.kind === 'arrival')

  // Порядок — по времени: airdrop 5 февраля, депозит 10-го, конвертация в марте.
  expect(arrivals).toMatchObject([
    { ticker: 'WLDUSDT', quantity: '3' },
    { ticker: 'BTCUSDT', quantity: '0.01' },
    { ticker: 'XUSDT', quantity: '500' },
  ])
  // Цены у прихода нет вовсе: её неоткуда взять.
  expect(arrivals.every((operation) => operation.price === undefined)).toBe(true)
})

// Деньги: P2P-покупка стейблкоина и его депозит — взносы, вывод — снятие.
// Переводы между своими кошельками не движение денег, а перекладывание.
it('стейблкоины идут деньгами, переводы между своими кошельками — нет', () => {
  const cash = statement().operations.filter((operation) => operation.kind === 'cash')

  // P2P 15 января, депозит стейблкоина 20-го, вывод 2 апреля.
  expect(cash.map((operation) => operation.amount)).toEqual(['200', '50', '-10'])
  expect(cash.every((operation) => operation.cashKind === 'deposit')).toBe(true)
})

// Вывод монеты уменьшает остаток на бирже, а операции «списать лот без
// продажи» в журнале нет. Молчать нельзя: иначе остаток разойдётся.
it('вывод монеты не применяется, но попадает в счётчик', () => {
  expect(statement().skipped.withdrawals).toBe(1)
})

// Граница по дате отбрасывает **только сделки**: это они приезжают по API со
// своим идентификатором, и только их можно задвоить.
it('сделки новее границы отбрасываются и считаются', () => {
  const result = parseBybitStatement(statementArchive(), new Date('2024-02-04T00:00:00.000Z'))
  const kept = result.operations.filter((operation) => operation.kind === 'trade')

  expect(kept.every((operation) => operation.executedAt < '2024-02-04')).toBe(true)
  expect(result.skipped.newer).toBeGreaterThan(0)
})

// А приход монеты граница знать не должна: по API он не приезжает никогда, и
// отбросив его по дате, мы потеряем единственный источник себестоимости для
// монет, пришедших не покупкой.
//
// Поймано на живой выгрузке 24.10.2026: с границей на всё пять BTC-депозитов
// исчезали, и именно они объясняют продажи, висевшие без покупок.
it('приход монеты и деньги границу переживают', () => {
  const result = parseBybitStatement(statementArchive(), new Date('2024-02-04T00:00:00.000Z'))

  const arrivals = result.operations.filter((operation) => operation.kind === 'arrival')
  expect(arrivals.map((operation) => operation.ticker)).toEqual(['WLDUSDT', 'BTCUSDT', 'XUSDT'])
  expect(arrivals.some((operation) => operation.executedAt > '2024-02-04')).toBe(true)
  expect(result.operations.filter((operation) => operation.kind === 'cash')).toHaveLength(3)
})

// Порядок важен: применение идёт по списку, и продажа раньше своей покупки
// уехала бы в отложенные без причины.
it('операции отсортированы по времени', () => {
  const times = statement().operations.map((operation) => operation.executedAt)

  expect(times).toEqual([...times].toSorted())
})

// Незнакомый файл — не повод молчать: формат выгрузки меняется, и об этом
// должен узнать человек, а не только лог.
it('незнакомый файл архива попадает в список пропущенных', () => {
  const result = parseBybitStatement(archiveWithUnknownFile())

  expect(result.skipped.unknownFiles).toEqual(['somethingElse_1.csv'])
  expect(result.operations).toEqual([])
})

// Строка с незнакомым типом, от которой монета прибавилась, — это приход без
// себестоимости: конвертация токена, ребрендинг, промо. Поймано на живой
// выгрузке: 146 956 токенов появились строкой с типом «--», разборщик их
// потерял, и продажа этих токенов повисла отложенной навсегда.
it('незнакомый тип с прибавкой монеты становится приходом', () => {
  const arrivals = statement().operations.filter((operation) => operation.kind === 'arrival')

  expect(arrivals.map((operation) => operation.ticker)).toContain('XUSDT')
  expect(arrivals.find((operation) => operation.ticker === 'XUSDT')?.quantity).toBe('500')
})
