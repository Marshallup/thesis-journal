import { z } from 'zod'

export const createInstrumentSchema = z.object({
  // Тикер нормализуется здесь же: иначе «SBER», «sber » и «Sber» станут тремя
  // инструментами, и сделки по одной бумаге разъедутся по трём позициям.
  symbol: z.string().trim().min(1).max(32).toUpperCase(),
  class: z.enum(['equity', 'bond', 'etf', 'crypto', 'currency']),
  // Три-десять символов, как и CHECK в базе: тикеры стейблкоинов в ISO 4217 не
  // укладываются — `USDT`, `USDC`. Проверка длины осталась тройкой после
  // задачи 20, которая расширила колонки, и первая же крипто-сделка упёрлась
  // в неё, а не в базу.
  currency: z.string().trim().min(3).max(10).toUpperCase(),
})

export type CreateInstrument = z.infer<typeof createInstrumentSchema>

export const createInstrumentOpenApiSchema = z.toJSONSchema(createInstrumentSchema, {
  target: 'openapi-3.0',
})
