import { Module } from '@nestjs/common'
import { TerminusModule } from '@nestjs/terminus'
import { DbModule } from '../db/db.module.ts'
import { HealthController } from './health.controller.ts'

@Module({
  imports: [DbModule, TerminusModule],
  controllers: [HealthController],
})
export class HealthModule {}
