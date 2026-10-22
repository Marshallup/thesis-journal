-- Обработанные сообщения. Нужны потому, что relay может упасть между
-- отправкой и отметкой, и событие придёт второй раз: «effectively-once»
-- держится не брокером, а этой таблицей.
--
-- Ключ дедупликации — идентификатор события, а не офсет. Офсеты обнулятся при
-- пересоздании топика, а идентификатор события — тот же самый uuid из
-- ingestor.outbox_events, и он не повторится никогда.
create table "processed_messages" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    -- Имя потребителя: одно и то же событие законно обрабатывают несколько
    -- консьюмеров, и дедупликация у каждого своя.
    "consumer" TEXT NOT NULL,
    "event_id" UUID NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_messages_pkey" PRIMARY KEY ("id")
);

-- Гонка невозможна не из-за проверки в коде, а из-за этого индекса: два
-- экземпляра консьюмера, получившие дубль одновременно, дадут одну вставку.
create unique index "processed_message_identity"
  ON "processed_messages"("consumer", "event_id");
