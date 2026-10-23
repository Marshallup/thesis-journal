-- Обработанные сообщения: дедупликация потребителей событий.
--
-- Relay может упасть между отправкой и отметкой, поэтому дубль — штатная
-- работа, а не сбой. «Effectively-once» держится этой таблицей, а не
-- брокером.
--
-- Ключ — идентификатор события, а не офсет: офсеты обнулятся при пересоздании
-- топика, а uuid события не повторится никогда.

CREATE TABLE public.processed_messages (
    id uuid DEFAULT uuidv7() NOT NULL,
    consumer text NOT NULL,
    event_id uuid NOT NULL,
    processed_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY public.processed_messages
    ADD CONSTRAINT processed_messages_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX processed_message_identity ON public.processed_messages USING btree (consumer, event_id);
