import { z } from 'zod'

// В Zod 4 форматы живут на верхнем уровне: z.url(), не z.string().url().
const schema = z.object({
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
})

export type Env = z.infer<typeof schema>

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source)
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ')
    throw new Error(`Invalid environment: ${fields}`)
  }
  return parsed.data
}
