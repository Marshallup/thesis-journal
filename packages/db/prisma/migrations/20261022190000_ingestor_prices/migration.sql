-- Цены, как их отдала биржа. Источник истины принадлежит тому, кто их
-- получает: пишет и читает только ingestor.
--
-- Та же форма, что у public.instrument_prices, и это не дубль, а две роли
-- одних данных: здесь запись владельцем, там проекция для экранов (задача
-- 19e). Разойтись они не могут — проекция строится из событий этой таблицы.
create table "ingestor"."instrument_prices" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "instrument_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "price" DECIMAL(28,8) NOT NULL,
    "quoted_at" TIMESTAMPTZ(6) NOT NULL,
    "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Имя как у таблицы: Prisma выводит имя первичного ключа из имени
    -- таблицы, и своё название она считает расхождением со схемой.
    CONSTRAINT "instrument_prices_pkey" PRIMARY KEY ("id")
);

-- Повторный прогон опроса не должен задваивать точку: вне торгов ISS отдаёт
-- ту же quoted_at, и вставка просто ничего не делает.
create unique index "provider_price_identity"
  ON "ingestor"."instrument_prices"("instrument_id", "source", "quoted_at");

-- Под выборку «с какого числа у нас есть история»: нужна и самая старая точка,
-- и самая свежая.
create index "provider_prices_instrument_quoted_at_idx"
  ON "ingestor"."instrument_prices"("instrument_id", "quoted_at" DESC);

-- Нулевая цена означает «торгов не было» — это дырка в данных, а не цена.
alter table "ingestor"."instrument_prices"
  ADD CONSTRAINT "provider_prices_price_check" CHECK ("price" > 0);

-- Права на новую таблицу: alter default privileges накрывает только таблицы,
-- созданные после него, а роль воркера создана тем же скриптом раньше.
-- Повтор безвреден и держит схему самодостаточной.
grant select, insert, update, delete on table "ingestor"."instrument_prices" to "thesis_ingestor";
