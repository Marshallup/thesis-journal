import { createHash, randomBytes } from 'node:crypto'
import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { hash, verify } from '@node-rs/argon2'
import { Prisma } from '@thesis/db'
import { PrismaService } from '../db/prisma.service.ts'
import type { Credentials } from './dto.ts'

const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000

export type Session = { accessToken: string; refreshToken: string; refreshExpiresAt: Date }

// Регистр не нормализует база: в PostgreSQL сравнение text чувствительно к нему.
const normalizeEmail = (email: string): string => email.toLowerCase()

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async register({ email, password }: Credentials): Promise<{ id: string; email: string }> {
    try {
      return await this.prisma.user.create({
        data: { email: normalizeEmail(email), passwordHash: await hash(password) },
        select: { id: true, email: true },
      })
    } catch (error) {
      // P2002 — нарушение уникального индекса по email.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('email already registered')
      }
      throw error
    }
  }

  async login({ email, password }: Credentials): Promise<Session> {
    const user = await this.prisma.user.findUnique({ where: { email: normalizeEmail(email) } })
    // Постоянное время здесь смысла не имеет: регистрация и так отвечает 409
    // на занятый адрес, то есть существование аккаунта уже наблюдаемо.
    if (!user || !(await verify(user.passwordHash, password))) {
      throw new UnauthorizedException()
    }

    return this.prisma.$transaction((tx) => this.issue(user.id, tx))
  }

  async rotate(rawToken: string): Promise<Session> {
    const tokenHash = sha256(rawToken)

    return this.prisma.$transaction(async (tx) => {
      // Проверка и списание — одной операцией: DELETE … RETURNING. Параллельный
      // запрос с тем же токеном строки не найдёт и получит 401.
      const consumed = await tx.refreshToken
        .delete({ where: { tokenHash } })
        .catch((error: unknown) => {
          // P2025 — строки нет: токен неизвестен или уже списан.
          const notFound =
            error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025'
          if (notFound) return null
          throw error
        })

      if (!consumed || consumed.expiresAt < new Date()) throw new UnauthorizedException()

      return this.issue(consumed.userId, tx)
    })
  }

  private async issue(userId: string, tx: Prisma.TransactionClient): Promise<Session> {
    const refreshToken = randomBytes(32).toString('base64url')
    const refreshExpiresAt = new Date(Date.now() + REFRESH_TTL_MS)

    // Храним хеш, а не токен: утечка дампа базы не должна давать живые сессии.
    await tx.refreshToken.create({
      data: { userId, tokenHash: sha256(refreshToken), expiresAt: refreshExpiresAt },
    })

    return {
      accessToken: await this.jwt.signAsync({ sub: userId }),
      refreshToken,
      refreshExpiresAt,
    }
  }
}
