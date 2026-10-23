-- Ключи от биржи: маска у api, шифротекст у воркера.
--
-- Разделение не декоративное. На биржу ходит ingestor — значит, расшифровать
-- ключ должен он, и шифротекст живёт в его схеме. Человеку нужен список своих
-- ключей — значит, у api есть своя строка, и в ней нет ни ключа, ни
-- шифротекста, ни nonce. Экран, который нечем скомпрометировать, надёжнее
-- экрана, который «не показывает» секрет.
--
-- Мастер-ключ в базе не хранится вовсе: он лежит файлом на сервере, и оба
-- процесса читают его оттуда. Ключ рядом с шифротекстом не защищает ни от
-- чего — унёсший базу унёс и то, и другое.

CREATE TABLE public.api_keys (
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    exchange text NOT NULL,
    key_mask text NOT NULL,
    status text NOT NULL,
    permissions jsonb,
    verified_at timestamp(6) with time zone,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT api_keys_status_check CHECK ((status = ANY (ARRAY['unverified'::text, 'active'::text, 'rejected'::text])))
);

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);

-- Один ключ на счёт и биржу: второй ключ к тому же счёту — это замена
-- первого, а не ещё одна запись. Повторная отправка перезаписывает.
CREATE UNIQUE INDEX api_key_per_exchange ON public.api_keys USING btree (account_id, exchange);

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY api_keys_isolation ON public.api_keys USING ((account_id IN ( SELECT accounts.id
   FROM public.accounts
  WHERE (accounts.user_id = (current_setting('app.user_id'::text))::uuid))));

-- Схема воркера: здесь шифротекст и публичная часть ключа.
--
-- Внешнего ключа на public.accounts нет намеренно. Прав на эту схему у роли
-- воркера нет, а ссылка через границу сервисов сделала бы удаление счёта в api
-- зависимым от таблицы воркера. Цена решения — осиротевший шифротекст после
-- удаления счёта; запись в docs/unknowns.md.
CREATE TABLE ingestor.exchange_keys (
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    exchange text NOT NULL,
    api_key_public text NOT NULL,
    -- bytea, а не base64 в text: кодировка — дело транспорта, а в базе байты
    -- должны быть байтами, иначе длина и равенство врут.
    ciphertext bytea NOT NULL,
    nonce bytea NOT NULL,
    tag bytea NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) with time zone NOT NULL
);

ALTER TABLE ONLY ingestor.exchange_keys
    ADD CONSTRAINT exchange_keys_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX exchange_key_per_account ON ingestor.exchange_keys USING btree (account_id, exchange);

-- Права на таблицы воркера выдаются здесь, а не скриптом ролей: на свежем
-- кластере скрипт выполняется до миграций, и схемы ingestor тогда ещё нет.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'thesis_ingestor') then
    execute $g$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ingestor.exchange_keys TO thesis_ingestor;$g$;
  end if;
end
$$;
