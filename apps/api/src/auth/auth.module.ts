import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { JwtModule } from '@nestjs/jwt'
import { PassportModule } from '@nestjs/passport'
import type { Env } from '../config/env.ts'
import { DbModule } from '../db/db.module.ts'
import { AuthController } from './auth.controller.ts'
import { AuthService } from './auth.service.ts'
import { JwtStrategy } from './jwt.strategy.ts'

@Module({
  imports: [
    DbModule,
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get('JWT_ACCESS_SECRET', { infer: true }),
        signOptions: { expiresIn: '15m' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  // JwtModule наружу: шлюз сокетов проверяет тот же access-токен тем же
  // секретом, и второй настройки у него быть не должно.
  exports: [JwtModule],
})
export class AuthModule {}
