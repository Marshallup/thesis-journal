import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module.ts'
import { AccountsController } from './accounts.controller.ts'

@Module({ imports: [DbModule], controllers: [AccountsController] })
export class AccountsModule {}
