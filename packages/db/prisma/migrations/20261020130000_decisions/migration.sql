-- Решения, их ревизии и связь со сделками.
--
-- Ядро решения неизменяемо, и держит это триггер в базе, а не сервис:
-- сервисов будет четыре, база одна. Триггер сравнивает строку целиком за
-- вычетом изменяемых колонок — любая колонка, добавленная позже, по умолчанию
-- станет неизменяемой. `unrealized` исключён намеренно: его выставляет учёт
-- несовершённых решений.
--
-- Правка решения — это новая строка в decision_revisions с полным снимком.
-- Правок у правок не бывает.
--
-- Уникальность по trade_id в decision_trades: одна сделка исполняет одно
-- решение. Обратное не запрещено — решение может исполниться несколькими
-- сделками.
--
-- horizon_days — срок на исполнение (его читает матчинг), hold_days — срок
-- удержания, и он может быть пустым: у продажи его нет, а у старых решений
-- не было вовсе.

CREATE FUNCTION public.forbid_decision_core_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if (to_jsonb(new) - 'unrealized') is distinct from (to_jsonb(old) - 'unrealized') then
    raise exception 'decisions are immutable, create a revision instead'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

CREATE TABLE public.decision_revisions (
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    decision_id uuid NOT NULL,
    thesis text NOT NULL,
    horizon_days integer NOT NULL,
    conviction integer NOT NULL,
    mood text NOT NULL,
    invalidator text,
    tags text[],
    free_text text,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    hold_days integer,
    CONSTRAINT decision_revisions_conviction_check CHECK (((conviction >= 1) AND (conviction <= 5))),
    CONSTRAINT decision_revisions_hold_days_positive CHECK (((hold_days IS NULL) OR (hold_days > 0))),
    CONSTRAINT decision_revisions_horizon_check CHECK ((horizon_days > 0)),
    CONSTRAINT decision_revisions_mood_known CHECK ((mood = ANY (ARRAY['calm'::text, 'thrill'::text, 'fear'::text, 'boredom'::text, 'fomo'::text])))
);

CREATE TABLE public.decision_trades (
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    decision_id uuid NOT NULL,
    trade_id uuid NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.decisions (
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    instrument_id uuid NOT NULL,
    side text NOT NULL,
    thesis text NOT NULL,
    horizon_days integer NOT NULL,
    conviction integer NOT NULL,
    mood text NOT NULL,
    invalidator text,
    tags text[],
    free_text text,
    context_snapshot jsonb,
    post_factum boolean DEFAULT false NOT NULL,
    unrealized boolean DEFAULT false NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    hold_days integer,
    CONSTRAINT decisions_conviction_check CHECK (((conviction >= 1) AND (conviction <= 5))),
    CONSTRAINT decisions_hold_days_positive CHECK (((hold_days IS NULL) OR (hold_days > 0))),
    CONSTRAINT decisions_horizon_check CHECK ((horizon_days > 0)),
    CONSTRAINT decisions_mood_known CHECK ((mood = ANY (ARRAY['calm'::text, 'thrill'::text, 'fear'::text, 'boredom'::text, 'fomo'::text]))),
    CONSTRAINT decisions_side_check CHECK ((side = ANY (ARRAY['buy'::text, 'sell'::text])))
);

ALTER TABLE ONLY public.decision_revisions
    ADD CONSTRAINT decision_revisions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.decision_trades
    ADD CONSTRAINT decision_trades_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.decisions
    ADD CONSTRAINT decisions_pkey PRIMARY KEY (id);

CREATE INDEX decision_revisions_decision_id_created_at_idx ON public.decision_revisions USING btree (decision_id, created_at);

CREATE UNIQUE INDEX decision_trade_one_per_trade ON public.decision_trades USING btree (trade_id);

CREATE INDEX decision_trades_decision_id_idx ON public.decision_trades USING btree (decision_id);

CREATE INDEX decisions_account_id_instrument_id_created_at_idx ON public.decisions USING btree (account_id, instrument_id, created_at);

ALTER TABLE ONLY public.decision_revisions
    ADD CONSTRAINT decision_revisions_decision_id_fkey FOREIGN KEY (decision_id) REFERENCES public.decisions(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.decision_trades
    ADD CONSTRAINT decision_trades_decision_id_fkey FOREIGN KEY (decision_id) REFERENCES public.decisions(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.decision_trades
    ADD CONSTRAINT decision_trades_trade_id_fkey FOREIGN KEY (trade_id) REFERENCES public.trades(id) ON UPDATE CASCADE ON DELETE RESTRICT;

CREATE TRIGGER decisions_immutable BEFORE UPDATE ON public.decisions FOR EACH ROW EXECUTE FUNCTION public.forbid_decision_core_update();

ALTER TABLE public.decision_revisions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.decision_trades ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.decisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY decision_revisions_isolation ON public.decision_revisions USING ((account_id IN ( SELECT accounts.id
   FROM public.accounts
  WHERE (accounts.user_id = (current_setting('app.user_id'::text))::uuid))));

CREATE POLICY decision_trades_isolation ON public.decision_trades USING ((account_id IN ( SELECT accounts.id
   FROM public.accounts
  WHERE (accounts.user_id = (current_setting('app.user_id'::text))::uuid))));

CREATE POLICY decisions_isolation ON public.decisions USING ((account_id IN ( SELECT accounts.id
   FROM public.accounts
  WHERE (accounts.user_id = (current_setting('app.user_id'::text))::uuid))));
