// Записанный ответ MOEX ISS: форма настоящая, цифры выдуманы. В живой API из
// тестов не ходим.
export const moexResponse = {
  marketdata: {
    columns: ['SECID', 'LAST', 'MARKETPRICE', 'PREVPRICE', 'UPDATETIME', 'SYSTIME'],
    data: [
      ['SBER', 291.68, 292.26, 290.5, '10:53:03', '2026-10-22 11:08:03'],
      // Торгов сегодня не было: LAST пустой, цена берётся следующей колонкой.
      ['LKOH', null, 7301.5, 7295, '10:53:03', '2026-10-22 11:08:03'],
      // Бумага без единой цены: пропускается целиком.
      ['DEAD', null, null, null, '10:53:03', '2026-10-22 11:08:03'],
    ] as (string | number | null)[][],
  },
}

// Тот же момент, но цены другие — для проверки, что опоздавшая точка ничего
// не затирает.
export const moexResponseLater = {
  marketdata: {
    columns: moexResponse.marketdata.columns,
    data: [['SBER', 295.1, 295.4, 291.68, '11:20:00', '2026-10-22 11:35:00']] as (
      | string
      | number
      | null
    )[][],
  },
}
