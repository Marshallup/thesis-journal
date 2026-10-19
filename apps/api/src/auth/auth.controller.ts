import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { ApiBearerAuth, ApiBody, ApiOperation } from '@nestjs/swagger'
import type { Request, Response } from 'express'
import { AuthService } from './auth.service.ts'
import type { Session } from './auth.service.ts'
import { CurrentUser } from './current-user.decorator.ts'
import type { AuthenticatedUser } from './current-user.decorator.ts'
import { credentialsOpenApiSchema, credentialsSchema } from './dto.ts'
import type { Credentials } from './dto.ts'

// Zod отдаёт JSON Schema, а @nestjs/swagger ждёт свой SchemaObject. На
// рантайме это один объект, но при exactOptionalPropertyTypes типы не сходятся,
// поэтому тип берём из публичной сигнатуры декоратора и приводим осознанно.
type ApiBodySchema = Extract<Parameters<typeof ApiBody>[0], { schema: unknown }>['schema']

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
  @ApiOperation({ summary: 'Регистрация' })
  @ApiBody({ schema: credentialsOpenApiSchema as ApiBodySchema })
  register(@Body({ schema: credentialsSchema }) body: Credentials) {
    return this.auth.register(body)
  }

  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Вход: access-токен в теле, refresh в httpOnly-cookie' })
  @ApiBody({ schema: credentialsOpenApiSchema as ApiBodySchema })
  async login(
    @Body({ schema: credentialsSchema }) body: Credentials,
    @Res({ passthrough: true }) response: Response,
  ) {
    const session = await this.auth.login(body)
    setRefreshCookie(response, session)
    return { accessToken: session.accessToken }
  }

  // Первый защищённый маршрут: до него access-токен никто не проверял.
  @Get('me')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Текущий пользователь по access-токену' })
  me(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user
  }

  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Ротация: старый refresh списывается, выдаётся новый' })
  async refresh(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const session = await this.auth.rotate(readRefreshToken(request))
    setRefreshCookie(response, session)
    return { accessToken: session.accessToken }
  }
}
