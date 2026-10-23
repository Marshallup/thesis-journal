// Ответы Bybit на /v5/execution/list. Суммы и идентификаторы выдуманы:
// настоящих выгрузок в репозитории не бывает.
//
// Форма взята из документации v5: конверт retCode/retMsg/result, внутри list и
// nextPageCursor. Пустой курсор значит «выбрано всё».

type Row = {
  execId: string
  symbol: string
  side: 'Buy' | 'Sell'
  execPrice: string
  execQty: string
  execFee: string
  feeCurrency: string
  execTime: string
  execType: string
}

function row(over: Partial<Row> & { execId: string }): Row {
  return {
    symbol: 'BTCUSDT',
    side: 'Buy',
    execPrice: '64000',
    execQty: '0.01',
    // Спотовая покупка платит комиссию купленной монетой.
    execFee: '0.00001',
    feeCurrency: 'BTC',
    execTime: '1792000000000',
    execType: 'Trade',
    ...over,
  }
}

export const firstPage = {
  retCode: 0,
  retMsg: 'OK',
  result: {
    list: [row({ execId: 'exec-1' }), row({ execId: 'exec-2', execPrice: '64100' })],
    nextPageCursor: 'page-2',
  },
}

export const secondPage = {
  retCode: 0,
  retMsg: 'OK',
  result: {
    list: [
      row({
        execId: 'exec-3',
        side: 'Sell',
        execQty: '0.005',
        execPrice: '65000',
        // Продажа платит комиссию вырученной монетой.
        execFee: '0.325',
        feeCurrency: 'USDT',
      }),
      // Не сделка: списание фондирования приезжает в том же списке.
      row({ execId: 'exec-4', execType: 'Funding', execFee: '0.1', feeCurrency: 'USDT' }),
    ],
    nextPageCursor: '',
  },
}

export const emptyPage = {
  retCode: 0,
  retMsg: 'OK',
  result: { list: [], nextPageCursor: '' },
}

// Биржа вернула тот же курсор: признак неисправности на её стороне, крутиться
// по нему вечно нельзя.
export const loopingPage = {
  retCode: 0,
  retMsg: 'OK',
  result: { list: [row({ execId: 'exec-5' })], nextPageCursor: 'page-2' },
}
