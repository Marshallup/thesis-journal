import { defineConfig } from 'vitest/config'

// Интеграционные тесты лежат в test/, юниты — в src/. Отдельный конфиг нужен,
// чтобы `pnpm test` не поднимал контейнеры.
export default defineConfig({
  test: {
    include: ['{apps,packages}/*/test/**/*.{int,e2e}.test.ts'],
    // Переменные окружения надо выставить до импорта модулей теста.
    setupFiles: ['apps/api/test/setup-env.ts'],
    // Образ тянется и ждёт healthcheck — дефолтных 5 секунд не хватает.
    hookTimeout: 120_000,
    testTimeout: 60_000,
    // Порты на хосте общие: параллельные файлы дадут плавающие падения.
    fileParallelism: false,
  },
})
