import { VersioningType } from '@nestjs/common'
import type { INestApplication } from '@nestjs/common'
import { API_PREFIX, API_VERSION } from './api.ts'

// Настройка живёт здесь, а не в main.ts, по той же причине, по которой
// валидация подключена через APP_PIPE: тесты собирают приложение сами и
// bootstrap не зовут. Конфигурация, видимая только в main.ts, в тестах не
// проверяется — и расходится с продом незаметно.
export function configureApp(app: INestApplication): void {
  // Все публичные маршруты под /api/v1. Health исключён намеренно: по нему
  // ходят пробы инфраструктуры, и задача 48 проверяет деплой запросом к
  // /health — версионировать пробу значит ломать её при каждом v2.
  app.setGlobalPrefix(API_PREFIX, { exclude: ['health'] })
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: API_VERSION })
}
