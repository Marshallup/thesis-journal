import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module.ts'
import { ContextSnapshotService } from './context-snapshot.service.ts'
import { DecisionsController } from './decisions.controller.ts'
import { DecisionsService } from './decisions.service.ts'
import { MatchingService } from './matching.service.ts'

@Module({
  imports: [DbModule],
  controllers: [DecisionsController],
  providers: [DecisionsService, MatchingService, ContextSnapshotService],
  exports: [DecisionsService, MatchingService, ContextSnapshotService],
})
export class DecisionsModule {}
