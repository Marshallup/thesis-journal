import { z } from 'zod'

// Деньги и количества — строками. JSON-число потеряло бы точность ещё до
// валидации, а number для денег в проекте запрещён.
const decimal = z.string().regex(/^\d+(\.\d+)?$/, 'expected a non-negative decimal string')

export const applyTradeSchema = z.object({
  accountId: z.uuid(),
  instrumentId: z.uuid(),
  side: z.enum(['buy', 'sell']),
  quantity: decimal,
  price: decimal,
  fee: decimal,
  executedAt: z.iso.datetime(),
})

export type ApplyTrade = z.infer<typeof applyTradeSchema>

// Та же схема для OpenAPI: описывать тело второй раз руками — верный способ
// его рассинхронизировать.
export const applyTradeOpenApiSchema = z.toJSONSchema(applyTradeSchema, {
  target: 'openapi-3.0',
})
