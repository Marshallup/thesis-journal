import { Inject, Injectable } from '@nestjs/common'
import { Logger, PARAMS_PROVIDER_TOKEN, PinoLogger } from 'nestjs-pino'
import type { Params } from 'nestjs-pino'

// Тот же приём, что в api: стартовая простыня Nest понижается до debug, а не
// выбрасывается. Копия на двадцать строк, а не общий пакет: третий воркер
// появится в неделю 7, тогда и переедет.
//
// @Injectable() без scope обязателен: родительский Logger из nestjs-pino
// объявлен транзиентным, а транзиентного провайдера нельзя достать через
// app.get() — только resolve(). Переопределение области возвращает обычный
// синглтон, которого нам и надо.
const NOISY_CONTEXTS = new Set(['InstanceLoader', 'NestFactory'])

@Injectable()
export class QuietLogger extends Logger {
  constructor(logger: PinoLogger, @Inject(PARAMS_PROVIDER_TOKEN) params: Params) {
    super(logger, params)
  }

  // Контекст Nest передаёт последним аргументом.
  override log(message: unknown, ...optionalParams: unknown[]): void {
    const context = optionalParams.at(-1)
    if (typeof context === 'string' && NOISY_CONTEXTS.has(context)) {
      super.debug(message, ...optionalParams)
      return
    }
    super.log(message, ...optionalParams)
  }
}
