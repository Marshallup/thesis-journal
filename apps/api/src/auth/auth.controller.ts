import { Body, Controller, HttpCode, Post, Req, Res, UnauthorizedException } from '@nestjs/common'
import type { Request, Response } from 'express'
import { AuthService } from './auth.service.ts'
import type { Session } from './auth.service.ts'
import { credentialsSchema } from './dto.ts'
import type { Credentials } from './dto.ts'

const COOKIE = 'refresh_token'

function readRefreshToken(request: Request): string {
  // cookies заполняет cookie-parser, подключённый middleware в AppModule.
  const raw = request.cookies[COOKIE]
  if (typeof raw !== 'string' || !raw) throw new UnauthorizedException()
  return raw
}

function setRefreshCookie(response: Response, session: Session): void {
  response.cookie(COOKIE, session.refreshToken, {
    httpOnly: true,
    sameSite: 'strict',
    // Через http cookie с secure не доедет, а тесты и разработка идут по http.
    secure: process.env.NODE_ENV === 'production',
    path: '/auth',
    expires: session.refreshExpiresAt,
  })
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  register(@Body({ schema: credentialsSchema }) body: Credentials) {
    return this.auth.register(body)
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Body({ schema: credentialsSchema }) body: Credentials,
    @Res({ passthrough: true }) response: Response,
  ) {
    const session = await this.auth.login(body)
    setRefreshCookie(response, session)
    return { accessToken: session.accessToken }
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const session = await this.auth.rotate(readRefreshToken(request))
    setRefreshCookie(response, session)
    return { accessToken: session.accessToken }
  }
}
