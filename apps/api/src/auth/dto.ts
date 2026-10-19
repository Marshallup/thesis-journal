import { z } from 'zod'

export const credentialsSchema = z.object({
  email: z.email(),
  // Верхняя граница не прихоть: argon2 считает хеш тем дольше, чем длиннее
  // вход, и без ограничения это бесплатная нагрузка на сервер.
  password: z.string().min(12).max(200),
})

export type Credentials = z.infer<typeof credentialsSchema>
