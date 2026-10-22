-- Цены инструментов — проекция для экранов.
--
-- Общие данные, как справочник: RLS нет и быть не должно. Наполняет её
-- консьюмер событий от воркера; источник истины живёт в схеме ingestor.
--
-- Временной ряд, а не «последняя цена»: последняя — это max(quoted_at), и
-- опоздавшая точка ложится в историю, ничего не затирая. Защита от
-- опоздавших цен получается сама, без монотонного гарда.

CREATE TABLE public.instrument_prices (
    id uuid DEFAULT uuidv7() NOT NULL,
    instrument_id uuid NOT NULL,
    source text NOT NULL,
    price numeric(28,8) NOT NULL,
    quoted_at timestamp(6) with time zone NOT NULL,
    fetched_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT instrument_prices_price_check CHECK ((price > (0)::numeric))
);

ALTER TABLE ONLY public.instrument_prices
    ADD CONSTRAINT instrument_prices_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX instrument_price_identity ON public.instrument_prices USING btree (instrument_id, source, quoted_at);

CREATE INDEX instrument_prices_instrument_id_quoted_at_idx ON public.instrument_prices USING btree (instrument_id, quoted_at DESC);
