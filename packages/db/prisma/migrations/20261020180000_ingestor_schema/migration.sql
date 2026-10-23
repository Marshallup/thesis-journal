-- Схема воркера: граница между сервисами, выраженная правами.
--
-- `api` работает в public, `ingestor` — здесь. Это не договорённость, а
-- права: роль воркера не видит схему api, роль api не видит эту.
--
-- Внутри: цены как их отдала биржа (источник истины, из которого строится
-- проекция в public), сырьё отчётов байт в байт и исходящие события.
--
-- Outbox существует потому, что прямая отправка в брокер из сервиса не даёт
-- никаких гарантий: отправка после коммита может не случиться, отправка до
-- коммита может рассказать о том, чего нет. Событие пишется в одной
-- транзакции с данными, а relay отправляет его отдельным циклом.
--
-- RLS в этой схеме нет: пользовательских данных тут не бывает по определению.
-- Сырьё отчёта привязано к счёту, но живёт как байты провайдера.

CREATE SCHEMA ingestor;

CREATE TABLE ingestor.instrument_prices (
    id uuid DEFAULT uuidv7() NOT NULL,
    instrument_id uuid NOT NULL,
    source text NOT NULL,
    price numeric(28,8) NOT NULL,
    quoted_at timestamp(6) with time zone NOT NULL,
    fetched_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT provider_prices_price_check CHECK ((price > (0)::numeric))
);

CREATE TABLE ingestor.outbox_events (
    id uuid DEFAULT uuidv7() NOT NULL,
    topic text NOT NULL,
    key text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    published_at timestamp(6) with time zone
);

CREATE TABLE ingestor.raw_imports (
    id uuid DEFAULT uuidv7() NOT NULL,
    import_id uuid NOT NULL,
    source text NOT NULL,
    file_hash text NOT NULL,
    payload bytea NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY ingestor.instrument_prices
    ADD CONSTRAINT instrument_prices_pkey PRIMARY KEY (id);

ALTER TABLE ONLY ingestor.outbox_events
    ADD CONSTRAINT outbox_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY ingestor.raw_imports
    ADD CONSTRAINT raw_imports_pkey PRIMARY KEY (id);

CREATE INDEX outbox_events_unpublished_idx ON ingestor.outbox_events USING btree (id) WHERE (published_at IS NULL);

CREATE UNIQUE INDEX provider_price_identity ON ingestor.instrument_prices USING btree (instrument_id, source, quoted_at);

CREATE INDEX provider_prices_instrument_quoted_at_idx ON ingestor.instrument_prices USING btree (instrument_id, quoted_at DESC);

CREATE UNIQUE INDEX raw_import_per_import ON ingestor.raw_imports USING btree (import_id);

-- Права на таблицы воркера выдаются здесь, а не скриптом ролей: на свежем
-- кластере скрипт выполняется до миграций, и схемы ingestor тогда ещё нет.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'thesis_ingestor') then
    execute $g$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ingestor.instrument_prices TO thesis_ingestor;$g$;
  end if;
end
$$;

-- Права на таблицы воркера выдаются здесь, а не скриптом ролей: на свежем
-- кластере скрипт выполняется до миграций, и схемы ingestor тогда ещё нет.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'thesis_ingestor') then
    execute $g$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ingestor.outbox_events TO thesis_ingestor;$g$;
  end if;
end
$$;

-- Права на таблицы воркера выдаются здесь, а не скриптом ролей: на свежем
-- кластере скрипт выполняется до миграций, и схемы ingestor тогда ещё нет.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'thesis_ingestor') then
    execute $g$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ingestor.raw_imports TO thesis_ingestor;$g$;
  end if;
end
$$;
