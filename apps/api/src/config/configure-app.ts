import { VersioningType } from '@nestjs/common'
import type { INestApplication } from '@nestjs/common'
import { WsAdapter } from '@nestjs/platform-ws'
import { API_PREFIX, API_VERSION } from './api.ts'

// Не в main.ts: тесты собирают приложение сами, и конфигурация, видимая
// только в bootstrap, расходится с продом незаметно.
export function configureApp(app: INestApplication): void {
  // Всё под /api/v1, кроме health: по нему ходят пробы инфраструктуры, и
  // версионировать пробу значит ломать её при каждом v2.
  app.setGlobalPrefix(API_PREFIX, { exclude: ['health'] })
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: API_VERSION })
  // ws, а не socket.io: протокол стандартный, клиент в браузере встроенный, и
  // в вебе не появляется ни одной зависимости.
  app.useWebSocketAdapter(new WsAdapter(app))
}
