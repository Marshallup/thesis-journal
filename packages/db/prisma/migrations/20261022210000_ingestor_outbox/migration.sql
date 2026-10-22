-- Исходящие события. Пишутся в той же транзакции, что и сами данные: прямая
-- отправка в брокер из сервиса запрещена правилом проекта, и причина простая.
-- Отправка после коммита может не случиться — событие потеряно; отправка до
-- коммита может случиться, а коммит нет — событие о том, чего не было.
--
-- Отправляет их relay отдельным циклом. Между отправкой и отметкой он может
-- упасть, поэтому дубль в топике возможен — отсюда «effectively-once», а не
-- «exactly-once», и обязанность потребителя быть идемпотентным.
create table "ingestor"."outbox_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "topic" TEXT NOT NULL,
    -- Ключ сообщения: он выбирает партицию и тем задаёт порядок.
    "key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- NULL значит «ещё не отправлено»: это и есть очередь.
    "published_at" TIMESTAMPTZ(6),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- Частичный индекс: relay спрашивает только неотправленные, а их всегда
-- немного. Полный индекс по миллионам отправленных строк не нужен никому.
create index "outbox_events_unpublished_idx"
  ON "ingestor"."outbox_events"("id")
  WHERE "published_at" IS NULL;

grant select, insert, update, delete on table "ingestor"."outbox_events" to "thesis_ingestor";
