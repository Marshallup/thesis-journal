import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module.ts'
import { RabbitModule } from '../rabbit/rabbit.module.ts'
import { KeysController } from './keys.controller.ts'
import { KeysService } from './keys.service.ts'

@Module({
  imports: [DbModule, RabbitModule],
  controllers: [KeysController],
  providers: [KeysService],
})
export class KeysModule {}
