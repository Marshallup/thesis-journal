import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PassportStrategy } from '@nestjs/passport'
import { ExtractJwt, Strategy } from 'passport-jwt'
import type { Env } from '../config/env.ts'
import type { AuthenticatedUser } from './current-user.decorator.ts'

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService<Env, true>) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.get('JWT_ACCESS_SECRET', { infer: true }),
    })
  }

  // Возвращённое значение passport кладёт в request.user.
  validate(payload: { sub: string }): AuthenticatedUser {
    return { userId: payload.sub }
  }
}
