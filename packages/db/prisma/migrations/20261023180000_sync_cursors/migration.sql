-- Докуда синхронизирован счёт на бирже.
--
-- Курсор страницы здесь не хранится: он живёт внутри одного семидневного окна,
-- и падение посреди окна означает повтор окна целиком. Лишнего при этом не
-- случится — операции идемпотентны по `execId` биржи, и повторная заливка
-- отбивается ключом `trade_idempotency`.
--
-- Внешнего ключа на public.accounts нет по той же причине, что у exchange_keys:
-- это чужая схема, и прав на неё у роли воркера нет.
CREATE TABLE ingestor.sync_cursors (
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    stream text NOT NULL,
    synced_until timestamp(6) with time zone NOT NULL,
    updated_at timestamp(6) with time zone NOT NULL
);

ALTER TABLE ONLY ingestor.sync_cursors
    ADD CONSTRAINT sync_cursors_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX sync_cursor_per_stream ON ingestor.sync_cursors USING btree (account_id, stream);

-- Права на таблицы воркера выдаются здесь, а не скриптом ролей: на свежем
-- кластере скрипт выполняется до миграций, и схемы ingestor тогда ещё нет.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'thesis_ingestor') then
    execute $g$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ingestor.sync_cursors TO thesis_ingestor;$g$;
  end if;
end
$$;
