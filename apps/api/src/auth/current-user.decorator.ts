import { createParamDecorator } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'

export type AuthenticatedUser = { userId: string }

// Значение кладёт passport после успешной проверки access-токена.
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  return context.switchToHttp().getRequest<{ user: AuthenticatedUser }>().user
})
