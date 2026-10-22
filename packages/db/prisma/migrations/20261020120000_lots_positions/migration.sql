-- Лоты, списания и позиции: учёт по FIFO.
--
-- Лот — это покупка с остатком; списание — расход лота продажей, и в нём же
-- лежит реализованный результат. Позиция — свёртка по паре счёт и бумага,
-- она производная и существует ради скорости чтения.
--
-- Уникальность (lot_id, trade_id) у списаний — защита от двойного применения
-- одной и той же продажи к одному и тому же лоту.

CREATE TABLE public.lot_consumptions (
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    lot_id uuid NOT NULL,
    trade_id uuid NOT NULL,
    qty numeric(38,18) NOT NULL,
    cost numeric(28,8) NOT NULL,
    realized_pnl numeric(28,8) NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.lots (
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    instrument_id uuid NOT NULL,
    open_trade_id uuid NOT NULL,
    qty_open numeric(38,18) NOT NULL,
    qty_remaining numeric(38,18) NOT NULL,
    price numeric(28,8) NOT NULL,
    cost_open numeric(28,8) NOT NULL,
    cost_remaining numeric(28,8) NOT NULL,
    opened_at timestamp(6) with time zone NOT NULL
);

CREATE TABLE public.positions (
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    instrument_id uuid NOT NULL,
    quantity numeric(38,18) NOT NULL,
    cost_basis_total numeric(28,8) NOT NULL,
    realized_pnl numeric(28,8) NOT NULL,
    version integer DEFAULT 0 NOT NULL,
    updated_at timestamp(6) with time zone NOT NULL
);

ALTER TABLE ONLY public.lot_consumptions
    ADD CONSTRAINT lot_consumptions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.lots
    ADD CONSTRAINT lots_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.positions
    ADD CONSTRAINT positions_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX lot_consumption_idempotency ON public.lot_consumptions USING btree (lot_id, trade_id);

CREATE INDEX lots_account_id_instrument_id_opened_at_idx ON public.lots USING btree (account_id, instrument_id, opened_at);

CREATE UNIQUE INDEX positions_account_id_instrument_id_key ON public.positions USING btree (account_id, instrument_id);

ALTER TABLE ONLY public.lot_consumptions
    ADD CONSTRAINT lot_consumptions_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES public.lots(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.lot_consumptions
    ADD CONSTRAINT lot_consumptions_trade_id_fkey FOREIGN KEY (trade_id) REFERENCES public.trades(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.lots
    ADD CONSTRAINT lots_open_trade_id_fkey FOREIGN KEY (open_trade_id) REFERENCES public.trades(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE public.lot_consumptions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.lots ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.positions ENABLE ROW LEVEL SECURITY;

CREATE POLICY lot_consumptions_isolation ON public.lot_consumptions USING ((account_id IN ( SELECT accounts.id
   FROM public.accounts
  WHERE (accounts.user_id = (current_setting('app.user_id'::text))::uuid))));

CREATE POLICY lots_isolation ON public.lots USING ((account_id IN ( SELECT accounts.id
   FROM public.accounts
  WHERE (accounts.user_id = (current_setting('app.user_id'::text))::uuid))));

CREATE POLICY positions_isolation ON public.positions USING ((account_id IN ( SELECT accounts.id
   FROM public.accounts
  WHERE (accounts.user_id = (current_setting('app.user_id'::text))::uuid))));
