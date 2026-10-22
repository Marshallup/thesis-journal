-- Движения денег: дивиденды, купоны, налоги, комиссии, пополнения.
--
-- Таблица только дополняется, и это держит триггер: правка прошлого движения
-- разошлась бы с балансом, который по ней считается. Исправление — новая
-- строка, а не правка старой.
--
-- Сумма со знаком: комиссия отрицательна, дивиденд положителен. Знак в
-- данных, а не в толковании — иначе каждый читающий решает сам, и однажды
-- решит иначе.

CREATE FUNCTION public.forbid_cash_ledger_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'cash_ledger is append-only, post a reversing entry instead'
    using errcode = '23514';
end;
$$;

CREATE TABLE public.cash_ledger (
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    instrument_id uuid,
    kind text NOT NULL,
    amount numeric(28,8) NOT NULL,
    currency character varying(10) NOT NULL,
    occurred_at timestamp(6) with time zone NOT NULL,
    provider text NOT NULL,
    external_id text,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT cash_ledger_currency_length CHECK (((length((currency)::text) >= 3) AND (length((currency)::text) <= 10)))
);

ALTER TABLE ONLY public.cash_ledger
    ADD CONSTRAINT cash_ledger_pkey PRIMARY KEY (id);

CREATE INDEX cash_ledger_account_id_occurred_at_idx ON public.cash_ledger USING btree (account_id, occurred_at);

CREATE UNIQUE INDEX cash_ledger_idempotency ON public.cash_ledger USING btree (account_id, provider, external_id);

CREATE TRIGGER cash_ledger_append_only BEFORE DELETE OR UPDATE ON public.cash_ledger FOR EACH ROW EXECUTE FUNCTION public.forbid_cash_ledger_change();

ALTER TABLE public.cash_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY cash_ledger_isolation ON public.cash_ledger USING ((account_id IN ( SELECT accounts.id
   FROM public.accounts
  WHERE (accounts.user_id = (current_setting('app.user_id'::text))::uuid))));
