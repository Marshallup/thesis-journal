import { z } from 'zod'

// kind клиент не присылает вовсе: он однозначно следует из провайдера, а база
// связь между ними не проверяет — «Сбер + биржевой» прошёл бы молча.
export const createAccountSchema = z.object({
  // Необязательное: счёт часто заводят по ходу записи сделки, и требовать там
  // название — значит мешать. Назвать можно будет позже.
  name: z.string().trim().min(1).max(50).optional(),
  provider: z.enum(['bybit', 'bitget', 'tinvest', 'sber', 'manual']),
  baseCurrency: z.string().length(3).toUpperCase(),
  isIis: z.boolean().default(false),
})

export type CreateAccount = z.infer<typeof createAccountSchema>

export const createAccountOpenApiSchema = z.toJSONSchema(createAccountSchema, {
  target: 'openapi-3.0',
})
