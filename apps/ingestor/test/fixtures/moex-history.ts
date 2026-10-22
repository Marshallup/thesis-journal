// Записанный ответ исторического интерфейса MOEX ISS: форма настоящая, цифры
// выдуманы. В живой API из тестов не ходим.
//
// Главное в этой фикстуре — курсор. Страница истории отдаёт сто строк, и
// `history.cursor` сообщает [INDEX, TOTAL, PAGESIZE]. Без склейки страниц
// история обрывается на сотой точке, и график молча теряет годы.

type Row = (string | number | null)[]

// TRADEDATE, CLOSE, LEGALCLOSEPRICE — ровно те колонки, что запрашивает клиент.
const COLUMNS = ['TRADEDATE', 'CLOSE', 'LEGALCLOSEPRICE']

function day(index: number): Row {
  const date = new Date(Date.UTC(2021, 0, 4 + index))
  // Цена растёт на копейку в день: так в тесте видно, что порядок не потерян.
  const close = 100 + index / 100
  return [date.toISOString().slice(0, 10), close, close + 0.5]
}

// Страница: сто строк и курсор с общим числом.
export function historyPage(start: number, total: number) {
  const size = Math.min(100, Math.max(0, total - start))
  return {
    history: {
      columns: COLUMNS,
      data: Array.from({ length: size }, (_, i) => day(start + i)),
    },
    'history.cursor': { data: [[start, total, 100]] },
  }
}

// Бумага, которой на доске нет: ISS отвечает пустой историей, а не ошибкой.
export const emptyHistory = {
  history: { columns: COLUMNS, data: [] as Row[] },
  'history.cursor': { data: [[0, 0, 100]] },
}

// Строки с нулевой и отсутствующей ценой: в данных такое встречается, и точкой
// это не является — «торгов не было», а не «стоило ноль».
export const historyWithGaps = {
  history: {
    columns: COLUMNS,
    data: [
      ['2021-01-04', 100, 100.5],
      ['2021-01-05', null, null],
      ['2021-01-06', 0, 0],
      ['2021-01-07', 101, 101.5],
    ] as Row[],
  },
  'history.cursor': { data: [[0, 4, 100]] },
}
