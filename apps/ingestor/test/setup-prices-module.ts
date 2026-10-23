import { ConfigModule } from '@nestjs/config'
import { Test } from '@nestjs/testing'
import { DbModule } from '../src/db/db.module.ts'
import { ExternalCall } from '../src/outbound/external-call.ts'
import { PricesModule } from '../src/prices/prices.module.ts'
import { envSchema } from '../src/config/env.ts'

// Цены проверяются на фикстурах, а общий ограничитель — на настоящем Redis, в
// своих тестах. Здесь он подменён сквозным вызовом: иначе каждый тест про цены
// тянул бы за собой ещё один контейнер.
//
// ConfigModule всё равно нужен графу: в нём поднимается клиент Redis. Соединение
// ленивое, и ни одной команды в этих тестах не случится.
export async function createPricesModule() {
  const ref = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, validationSchema: envSchema }),
      DbModule,
      PricesModule,
    ],
  })
    .overrideProvider(ExternalCall)
    .useValue({ run: (_provider: string, fn: () => Promise<unknown>) => fn() })
    .compile()
  await ref.init()
  return ref
}
