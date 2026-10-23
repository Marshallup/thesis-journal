-- Импорт отчётов: статус для человека и отложенные операции.
--
-- Байтов отчёта здесь нет: сырьё провайдера принадлежит воркеру и лежит в
-- схеме ingestor. Здесь — то, что видит человек: статус, ошибка и итог
-- применения.
--
-- Отложенная операция — продажа, под которую в периоде отчёта нет покупок.
-- Это не ошибка импорта, а нормальное состояние: выгрузка Сбера ограничена
-- годом, и начало истории остаётся за её краем.

CREATE TABLE public.deferred_operations (
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    import_id uuid NOT NULL,
    instrument_id uuid NOT NULL,
    external_id text NOT NULL,
    side text NOT NULL,
    quantity numeric(38,18) NOT NULL,
    missing numeric(38,18) NOT NULL,
    occurred_at timestamp(6) with time zone NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT deferred_operations_side_check CHECK ((side = 'sell'::text))
);

CREATE TABLE public.imports (
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    source text NOT NULL,
    file_hash text NOT NULL,
    status text NOT NULL,
    error text,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    result jsonb,
    CONSTRAINT imports_status_check CHECK ((status = ANY (ARRAY['uploaded'::text, 'parsing'::text, 'parsed'::text, 'failed'::text])))
);

ALTER TABLE ONLY public.deferred_operations
    ADD CONSTRAINT deferred_operations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.imports
    ADD CONSTRAINT imports_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX deferred_operation_identity ON public.deferred_operations USING btree (import_id, external_id);

CREATE INDEX deferred_operations_account_id_instrument_id_idx ON public.deferred_operations USING btree (account_id, instrument_id);

CREATE UNIQUE INDEX import_idempotency ON public.imports USING btree (account_id, file_hash);

ALTER TABLE ONLY public.deferred_operations
    ADD CONSTRAINT deferred_operations_import_id_fkey FOREIGN KEY (import_id) REFERENCES public.imports(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE public.deferred_operations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.imports ENABLE ROW LEVEL SECURITY;

CREATE POLICY deferred_operations_isolation ON public.deferred_operations USING ((account_id IN ( SELECT accounts.id
   FROM public.accounts
  WHERE (accounts.user_id = (current_setting('app.user_id'::text))::uuid))));

CREATE POLICY imports_isolation ON public.imports USING ((account_id IN ( SELECT accounts.id
   FROM public.accounts
  WHERE (accounts.user_id = (current_setting('app.user_id'::text))::uuid))));
