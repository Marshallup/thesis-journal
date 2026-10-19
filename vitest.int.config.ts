import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

// Интеграционные тесты лежат в test/, юниты — в src/. Отдельный конфиг нужен,
// чтобы `pnpm test` не поднимал контейнеры.
export default defineConfig({
  // Vitest по умолчанию трансформирует через esbuild, а он не умеет
  // emitDecoratorMetadata — без этого DI в Nest не находит типы.
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2023',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    include: ['{apps,packages}/*/test/**/*.{int,e2e}.test.ts'],
    // Образ тянется и ждёт healthcheck — дефолтных 5 секунд не хватает.
    hookTimeout: 120_000,
    testTimeout: 60_000,
    // Порты на хосте общие: параллельные файлы дадут плавающие падения.
    fileParallelism: false,
  },
})
