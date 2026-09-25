# Thesis — инструкции для агентов

Дневник инвестиционных решений. Учебный проект: цель — не скорость доставки, а понимание. Подробности — `docs/design.md`, планы — `docs/plans/`.

## Команды

```bash
pnpm install
docker compose up -d          # postgres, redis, rabbitmq, kafka, clickhouse
pnpm db:generate              # обязательно после каждого изменения schema.prisma
pnpm db:migrate               # prisma migrate dev
pnpm dev                      # api :3000, web :5173
pnpm test                     # unit + property-based
pnpm test:int                 # интеграционные, поднимают контейнеры (Testcontainers)
pnpm lint                     # oxlint
pnpm typecheck
```

## Стек и версии

Node 24 LTS, pnpm 12, TypeScript 7, NestJS 12, Prisma 7, PostgreSQL 18, Redis 8, RabbitMQ 4, Kafka 4, ClickHouse, React 19 + Vite 8, Tailwind 4, Base UI 1.8, Vitest 5, Testcontainers 12.

Версии не апгрейдить в рамках задачи, не относящейся к апгрейду.

## Структура

Монорепозиторий pnpm. `apps/api` — REST + auth + WebSocket, `apps/ingestor` — коннекторы к биржам, `apps/core` — сделки, лоты, решения, `apps/notifier` — алерты, `apps/web` — React SPA. `packages/contracts` — типы событий и денежные примитивы, `packages/db` — схема Prisma и миграции.

Каждый сервис ходит только в свою схему PostgreSQL. В чужие таблицы — через API или события, никогда напрямую.

## Жёсткие правила

1. **Деньги и количества — только `Money` из `@thesis/contracts`.** `number` для денег запрещён везде, включая тесты и фикстуры. В БД — `numeric`, наружу — строки.
2. **Времена — `timestamptz`, хранение в UTC.** Часовые пояса считать через `Intl`, не прибавлением часов.
3. **Никаких «сначала SELECT, потом INSERT»** там, где возможна гонка: `ON CONFLICT`, атомарный `UPDATE … WHERE`, advisory lock.
4. **Консьюмер не коммитит офсет до того, как записал результат в БД.**
5. **Каждый внешний вызов** идёт через rate limiter и circuit breaker.
6. Код, имена и коммиты — на английском. Документация в `docs/` — на русском.

## Prisma 7 — не как в старых примерах

- Генератор `prisma-client` (не `prisma-client-js`), поле `output` обязательно, клиент **не** генерируется в `node_modules`.
- Импорт из сгенерированного пути (`../generated/prisma/client`), **не** из `@prisma/client`.
- Драйвер-адаптер обязателен: `PrismaPg` из `@prisma/adapter-pg`.
- Конфигурация — `prisma.config.ts` в корне, переменные окружения подключаются явно (`import "dotenv/config"`).
- `prisma migrate dev` больше **не** запускает `prisma generate` — вызывать отдельно.
- Middleware удалены, вместо них `$extends`.

## NestJS 12 — не как в старых примерах

- ESM по умолчанию, Node 20.19+.
- Валидация — Zod через Standard Schema прямо в декораторах маршрутов. `class-validator` и `class-transformer` не подключать.
- Тесты — Vitest, не Jest. Линтер — oxlint, не ESLint.
- Воркеры (`ingestor`, `core`, `notifier`) поднимаются через `NestFactory.createApplicationContext`, HTTP-сервер им не нужен.

## Git

Trunk-based: `main` всегда зелёный и задеплоенный. Одна задача из плана = ветка `task/NN-<slug>` = PR в `main` со squash-merge. Ветки `dev` нет. Деплой по тегу `v*`.

Ветка живёт не дольше четырёх часов, дифф — до ~300 строк. Не влезает — это две задачи.

Не коммитить и не пушить без явной просьбы.

## Чего не делать никогда

- Не класть в репозиторий настоящие брокерские отчёты и выгрузки — только обезличенные фикстуры с выдуманными суммами.
- Не читать и не править файлы окружения без отдельной просьбы.
- Не ходить в живые внешние API из тестов — только фикстуры и sandbox.
- Не добавлять зависимость, не сказав об этом: у каждой должна быть причина, которую можно назвать вслух.
