import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module.ts'
import { HealthController } from './health.controller.ts'

@Module({
  imports: [DbModule],
  controllers: [HealthController],
})
export class HealthModule {}
