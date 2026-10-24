// Ответы Bybit на /v5/user/query-api. Значения выдуманы: настоящих ключей и
// идентификаторов в репозитории не бывает.
//
// Форма взята из документации v5: конверт retCode/retMsg/result, внутри флаг
// readOnly (0 — чтение и запись, 1 — только чтение) и группы прав.

export const readOnlyKey = {
  retCode: 0,
  retMsg: '',
  result: {
    id: '0000001',
    note: 'thesis',
    apiKey: 'bybitPublicPart7f3a',
    readOnly: 1,
    secret: '',
    permissions: {
      ContractTrade: [],
      Spot: [],
      Wallet: [],
      Options: [],
      Derivatives: [],
      CopyTrading: [],
      BlockTrade: [],
      Exchange: ['ExchangeHistory'],
      NFT: [],
      Affiliate: [],
    },
    ips: ['*'],
    type: 1,
    createdAt: '2026-10-23T09:00:00Z',
    uta: 1,
    userID: 1,
    isMaster: true,
  },
}

// Тот же ключ, но с правом торговать: readOnly = 0 и непустые группы.
export const tradingKey = {
  ...readOnlyKey,
  result: {
    ...readOnlyKey.result,
    readOnly: 0,
    permissions: {
      ...readOnlyKey.result.permissions,
      ContractTrade: ['Order', 'Position'],
      Spot: ['SpotTrade'],
    },
  },
}

// Ключ только на чтение, но с правом вывода средств: проверяется отдельно от
// readOnly — вывод не нужен дневнику ни при каком флаге.
export const withdrawKey = {
  ...readOnlyKey,
  result: {
    ...readOnlyKey.result,
    permissions: { ...readOnlyKey.result.permissions, Wallet: ['Withdraw'] },
  },
}

// Отказ биржи: HTTP 200, а настоящий код — в retCode.
export const invalidKey = {
  retCode: 10003,
  retMsg: 'API key is invalid.',
  result: {},
}

// Биржа занята: ошибка провайдера, а не наша. Такое повторяется, а не
// превращается в вердикт по ключу.
export const busyExchange = {
  retCode: 10006,
  retMsg: 'Too many visits!',
  result: {},
}
