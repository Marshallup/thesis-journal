import { z } from 'zod'

// Закрытое множество: свободная строка уже дала в данных 'calm' рядом со
// 'спокойно', то есть один факт двумя значениями. Подписи живут в интерфейсе.
export const MOODS = ['calm', 'thrill', 'fear', 'boredom', 'fomo'] as const

// Поля, которые правятся ревизией. Собраны отдельно, чтобы схема создания и
// схема правки не разошлись при добавлении нового поля.
const revisable = {
  thesis: z.string().min(1).max(500),
  // Срок на исполнение: окно, в котором сделка относится к решению.
  horizonDays: z.number().int().positive(),
  // Срок удержания: на сколько человек заходит. У продажи его нет.
  holdDays: z.number().int().positive().max(36500).optional(),
  conviction: z.number().int().min(1).max(5),
  mood: z.enum(MOODS),
  invalidator: z.string().min(1).max(500).optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
  freeText: z.string().max(5000).optional(),
}

export const createDecisionSchema = z.object({
  accountId: z.uuid(),
  instrumentId: z.uuid(),
  side: z.enum(['buy', 'sell']),
  // Решение задним числом: тезис написан после сделки, и такие записи
  // исключаются из поведенческих срезов. Ставит клиент: ядро решения
  // неизменяемо, выставить метку можно только при создании.
  postFactum: z.boolean().optional(),
  // Решение задним числом заводится на конкретную сделку, и привязать её
  // должно само создание: автопривязка этого не умеет и не должна — она
  // требует, чтобы сделка была позже решения.
  tradeIds: z.array(z.uuid()).max(50).optional(),
  ...revisable,
})

export type CreateDecision = z.infer<typeof createDecisionSchema>

// В правке меняют одно-два поля, поэтому опционально всё — но не всё сразу.
export const reviseDecisionSchema = z
  .object({
    thesis: revisable.thesis.optional(),
    horizonDays: revisable.horizonDays.optional(),
    holdDays: revisable.holdDays,
    conviction: revisable.conviction.optional(),
    mood: revisable.mood.optional(),
    invalidator: revisable.invalidator,
    tags: revisable.tags,
    freeText: revisable.freeText,
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'nothing to revise',
  })

export type ReviseDecision = z.infer<typeof reviseDecisionSchema>

export const createDecisionOpenApiSchema = z.toJSONSchema(createDecisionSchema, {
  target: 'openapi-3.0',
})
