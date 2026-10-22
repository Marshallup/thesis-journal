import { Module } from '@nestjs/common'
import { PrismaService } from './prisma.service.ts'

// Один модуль на весь пул: если каждый фиче-модуль объявит PrismaService сам,
// он получит свой экземпляр и свой пул соединений.
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class DbModule {}
