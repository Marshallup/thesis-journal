-- Счета, справочник инструментов и сделки — ядро предметной области.
--
-- Счёт принадлежит человеку и через него же проходит путь к владельцу для
-- политик RLS: своей колонки пользователя у сделки нет. Справочник
-- инструментов общий для всех и политик не имеет — цена SBER одна на всех.
--
-- Идемпотентность сделки — по тройке (счёт, провайдер, внешний номер): один и
-- тот же отчёт, залитый дважды, не создаёт вторую сделку.
--
-- Права ролям выдаёт docker/postgres/init-app-role.sh: он выполняется раньше
-- миграций и ставит `alter default privileges`, поэтому новые таблицы в
-- public получают их сами. Явных grant здесь нет намеренно.

-- Валюта — text с проверкой длины, а не varchar(N). Разница не
-- стилистическая: тип с длиной режет молча при приведении
-- ('USDT'::char(3) отдаёт 'USD', 'ОЧЕНЬДЛИННАЯ'::varchar(10) — первые
-- десять символов), а text резать нечем, и слишком длинное значение
-- отбивает проверка — громко и в момент записи.

CREATE TABLE public.accounts (
    id uuid DEFAULT uuidv7() NOT NULL,
    user_id uuid NOT NULL,
    provider text NOT NULL,
    kind text NOT NULL,
    base_currency text NOT NULL,
    is_iis boolean DEFAULT false NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    name text,
    CONSTRAINT accounts_base_currency_length CHECK (((length((base_currency)::text) >= 3) AND (length((base_currency)::text) <= 10)))
);

CREATE TABLE public.instruments (
    id uuid DEFAULT uuidv7() NOT NULL,
    symbol text NOT NULL,
    class text NOT NULL,
    currency text NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT instruments_currency_length CHECK (((length((currency)::text) >= 3) AND (length((currency)::text) <= 10)))
);

CREATE TABLE public.trades (
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    instrument_id uuid NOT NULL,
    side text NOT NULL,
    quantity numeric(38,18) NOT NULL,
    price numeric(28,8) NOT NULL,
    fee numeric(28,8) NOT NULL,
    fee_currency text NOT NULL,
    executed_at timestamp(6) with time zone NOT NULL,
    provider text NOT NULL,
    external_id text,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT trade_side_check CHECK ((side = ANY (ARRAY['buy'::text, 'sell'::text]))),
    CONSTRAINT trades_fee_currency_length CHECK (((length((fee_currency)::text) >= 3) AND (length((fee_currency)::text) <= 10)))
);

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.instruments
    ADD CONSTRAINT instruments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.trades
    ADD CONSTRAINT trades_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX account_name_unique ON public.accounts USING btree (user_id, name);

CREATE INDEX accounts_user_id_idx ON public.accounts USING btree (user_id);

CREATE UNIQUE INDEX instruments_symbol_class_key ON public.instruments USING btree (symbol, class);

CREATE UNIQUE INDEX trade_idempotency ON public.trades USING btree (account_id, provider, external_id);

CREATE INDEX trades_account_id_executed_at_idx ON public.trades USING btree (account_id, executed_at);

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.trades ENABLE ROW LEVEL SECURITY;

CREATE POLICY accounts_isolation ON public.accounts USING ((user_id = (current_setting('app.user_id'::text))::uuid));

CREATE POLICY trades_isolation ON public.trades USING ((account_id IN ( SELECT accounts.id
   FROM public.accounts
  WHERE (accounts.user_id = (current_setting('app.user_id'::text))::uuid))));
