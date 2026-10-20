// Выполняется до импорта модулей теста. Это важно: ConfigModule.forRoot()
// валидирует схему в момент импорта app.module.ts, а не при создании приложения.
process.env.REDIS_URL ??= 'redis://localhost:6379'
process.env.JWT_ACCESS_SECRET ??= 'a'.repeat(32)
process.env.JWT_REFRESH_SECRET ??= 'r'.repeat(32)
// Заглушка: настоящий адрес каждый тест получает от Testcontainers и ставит
// перед созданием приложения, его читает PrismaService.
process.env.DATABASE_URL ??= 'postgresql://placeholder:placeholder@127.0.0.1:1/placeholder'
// То же для роли приложения: настоящий адрес ставит тест из db.appUrl.
process.env.APP_DATABASE_URL ??= 'postgresql://placeholder:placeholder@127.0.0.1:1/placeholder'
