import { Injectable } from '@nestjs/common'
import { Logger, PARAMS_PROVIDER_TOKEN, PinoLogger } from 'nestjs-pino'
import type { Params } from 'nestjs-pino'
import { Inject } from '@nestjs/common'

// Nest печатает при старте по строке на каждый модуль и каждый маршрут — сорок
// пять строк, и так на каждый перезапуск под watch. Это не выбрасывается, а
// понижается до debug: нужно — поднимите уровень логирования.
const NOISY_CONTEXTS = new Set([
  'InstanceLoader',
  'RoutesResolver',
  'RouterExplorer',
  'NestFactory',
])

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
