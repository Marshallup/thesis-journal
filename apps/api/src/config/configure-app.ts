import { VersioningType } from '@nestjs/common'
import type { INestApplication } from '@nestjs/common'
import { API_PREFIX, API_VERSION } from './api.ts'

// Не в main.ts: тесты собирают приложение сами, и конфигурация, видимая
// только в bootstrap, расходится с продом незаметно.
export function configureApp(app: INestApplication): void {
  // Всё под /api/v1, кроме health: по нему ходят пробы инфраструктуры, и
  // версионировать пробу значит ломать её при каждом v2.
  app.setGlobalPrefix(API_PREFIX, { exclude: ['health'] })
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: API_VERSION })
}
