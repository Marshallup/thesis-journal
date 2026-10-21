import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module.ts'
import { AccountsController } from './accounts.controller.ts'
import { AccountsService } from './accounts.service.ts'

@Module({
  imports: [DbModule],
  controllers: [AccountsController],
  providers: [AccountsService],
  exports: [AccountsService],
})
export class AccountsModule {}
