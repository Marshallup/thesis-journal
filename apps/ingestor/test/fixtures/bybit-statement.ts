import { strToU8, zipSync } from 'fflate'

// Выгрузка из кабинета Bybit: структура настоящая, суммы и адреса выдуманы.
// Настоящих выгрузок в репозитории не бывает — правило проекта.
//
// Воспроизведены все ловушки формата, которые нашлись на живых файлах:
// две ноги на спотовое исполнение, комиссия в купленной монете, одна строка на
// перпетуал, расчёты и ликвидации, два исполнения в одну секунду в старом
// кошельке без колонки цены, приход монеты не сделкой.

const SIGNATURE = 'UID: 1,Company Name: ,Country: '

const uta = [
  SIGNATURE,
  'Uid,Currency,Contract,Type,Direction,Quantity,Position,Filled Price,Funding,Fee Paid,Cash Flow,Change,Wallet Balance,Action,Time(UTC)',
  // Спотовая покупка: ушёл USDT, пришла монета, комиссия взята монетой.
  '1,USDT,TIAUSDT,TRADE,BUY,-100.00000000,0.00000000,8.00000000,0.00000000,0.00000000,-100.00000000,-100.00000000,900.00000000,--,2024-03-02 10:15:00',
  '1,TIA,TIAUSDT,TRADE,BUY,12.50000000,0.00000000,8.00000000,0.00000000,-0.01250000,12.50000000,12.48750000,12.48750000,--,2024-03-02 10:15:00',
  // Спотовая продажа: комиссия взята вырученным USDT.
  '1,TIA,TIAUSDT,TRADE,SELL,-7.50000000,0.00000000,9.00000000,0.00000000,0.00000000,-7.50000000,-7.50000000,4.98750000,--,2024-03-05 11:00:00',
  '1,USDT,TIAUSDT,TRADE,SELL,67.50000000,0.00000000,9.00000000,0.00000000,-0.06750000,67.50000000,67.43250000,867.43250000,--,2024-03-05 11:00:00',
  // Перпетуал: одна строка, всегда в валюте залога, Quantity — размер позиции.
  '1,USDT,BTCUSDT,TRADE,BUY,0.00300000,0.00300000,90000.00000000,0.00000000,-0.14850000,0.00000000,-0.14850000,867.28400000,--,2024-03-06 12:00:00',
  // Расчёт по позиции и ликвидация: производные, в журнал не идут.
  '1,USDT,BTCUSDT,SETTLEMENT,,0.00000000,0.00300000,0.00000000,-0.05000000,0.00000000,-0.05000000,-0.05000000,867.23400000,--,2024-03-06 20:00:00',
  '1,USDT,BTCUSDT,LIQUIDATION,,0.00300000,0.00000000,88000.00000000,0.00000000,-0.13200000,-120.00000000,-120.13200000,747.10200000,--,2024-03-07 03:00:00',
  // Перевод со своего же кошелька: не движение денег, а перекладывание.
  '1,BTC,,TRANSFER_IN,,0.00000000,0.00000000,0.00000000,0.00000000,0.00000000,0.01000000,0.01000000,0.01000000,--,2024-02-10 09:00:00',
  // Тип, которого мы не знаем: так выглядит конвертация токена. Монета
  // появилась, покупки у неё нет — это приход без себестоимости.
  '1,X,,--,--,0.00000000,0.00000000,0.00000000,0.00000000,0.00000000,500.00000000,500.00000000,500.00000000,--,2024-03-08 01:59:56',
].join('\n')

// Старый спотовый кошелёк: ни контракта, ни цены — только монета и сумма.
// 2024-02-01 два исполнения в одну секунду: цена у них одна, и спаривать ноги
// надо по цепочке остатков, иначе получится вдесятеро меньше.
const oldSpot = [
  SIGNATURE,
  'Uid,Type,Coin,Amount,Wallet Balance,Time(UTC)',
  '1,trade,USDT,-50.000000,55.000000,2024-02-01 08:00:00',
  '1,trade,USDT,-5.000000,50.000000,2024-02-01 08:00:00',
  '1,trade,NEAR,5.000000,5.000000,2024-02-01 08:00:00',
  '1,trade,NEAR,0.500000,5.500000,2024-02-01 08:00:00',
  '1,tradingFee,NEAR,-0.005500,5.494500,2024-02-01 08:00:00',
  // Продажа: комиссия в вырученном USDT.
  '1,trade,NEAR,-4.000000,1.494500,2024-02-03 09:30:00',
  '1,trade,USDT,44.000000,94.000000,2024-02-03 09:30:00',
  '1,tradingFee,USDT,-0.044000,93.956000,2024-02-03 09:30:00',
  // Монета пришла не сделкой: себестоимости у неё нет.
  '1,airdropAssetIncrease,WLD,3.000000,3.000000,2024-02-05 12:00:00',
  '1,internalAccountTransferWithdrawal,WLD,-3.000000,0.000000,2024-02-06 12:00:00',
].join('\n')

const fund = [
  SIGNATURE,
  'Uid,Date & Time(UTC),Coin,QTY,Type,Account Balance,Description',
  '1,2024-01-15 07:00:00,USDT,200.000000,Fiat,200.000000,P2P Purchase',
  '1,2024-01-15 07:05:00,USDT,-200.000000,Transfer out,0.000000,Transfer to Unified Trading Account',
].join('\n')

const deposits = [
  SIGNATURE,
  'Uid,Date,Type,Asset,Chain,Amount,Tx ID,Status,Received Address',
  '1,2024-02-10 08:55:00,Deposit,BTC,BTC,0.010000000000000000,txid-one,Completed,address-one',
  '1,2024-01-20 10:00:00,Deposit,USDT,TON,50.000000000000000000,txid-two,Completed,address-two',
  '1,2024-04-01 10:00:00,Withdraw,NEAR,NEAR,1.000000000000000000,txid-three,Transferred successfully,address-three',
  '1,2024-04-02 10:00:00,Withdraw,USDT,TON,10.000000000000000000,txid-four,Transferred successfully,address-four',
].join('\n')

export function statementArchive(): Buffer {
  return Buffer.from(
    zipSync({
      'AssetChangeDetails_1_20240101_20241231/AssetChangeDetails_uta_1_20240101_20241231_0.csv':
        strToU8(uta),
      'AssetChangeDetails_1_20240101_20241231/AssetChangeDetails_spot_1_20240101_20241231_0.csv':
        strToU8(oldSpot),
      'AssetChangeDetails_1_20240101_20241231/AssetChangeDetails_fund_1_20240101_20241231_0.csv':
        strToU8(fund),
      'assetHistory_1_20240101_20241231/assetHistory_withdrawDepositHistory_1_20240101_20241231_0.csv':
        strToU8(deposits),
    }),
  )
}

export function archiveWithUnknownFile(): Buffer {
  return Buffer.from(
    zipSync({ 'AssetChangeDetails_1/somethingElse_1.csv': strToU8(`${SIGNATURE}\nA,B\n1,2`) }),
  )
}
