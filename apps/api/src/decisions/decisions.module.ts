import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module.ts'
import { DecisionsController } from './decisions.controller.ts'
import { DecisionsService } from './decisions.service.ts'
import { MatchingService } from './matching.service.ts'

@Module({
  imports: [DbModule],
  controllers: [DecisionsController],
  providers: [DecisionsService, MatchingService],
  exports: [DecisionsService, MatchingService],
})
export class DecisionsModule {}
