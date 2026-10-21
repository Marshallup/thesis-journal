import { z } from 'zod'

export const createInstrumentSchema = z.object({
  // Тикер нормализуется здесь же: иначе «SBER», «sber » и «Sber» станут тремя
  // инструментами, и сделки по одной бумаге разъедутся по трём позициям.
  symbol: z.string().trim().min(1).max(32).toUpperCase(),
  class: z.enum(['equity', 'bond', 'etf', 'crypto', 'currency']),
  currency: z.string().length(3).toUpperCase(),
})

export type CreateInstrument = z.infer<typeof createInstrumentSchema>

export const createInstrumentOpenApiSchema = z.toJSONSchema(createInstrumentSchema, {
  target: 'openapi-3.0',
})
