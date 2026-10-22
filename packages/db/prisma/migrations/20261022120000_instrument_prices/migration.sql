-- Котировки. Общие данные, как справочник инструментов: RLS нет и быть не
-- должно — цена SBER одна на всех, кто его держит.
CREATE TABLE "instrument_prices" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "instrument_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "price" DECIMAL(28,8) NOT NULL,
    "quoted_at" TIMESTAMPTZ(6) NOT NULL,
    "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "instrument_prices_pkey" PRIMARY KEY ("id")
);

-- Повторный прогон планировщика не должен задваивать точку: вне торгов ISS
-- отдаёт ту же quoted_at, и вставка просто ничего не делает.
CREATE UNIQUE INDEX "instrument_price_identity"
  ON "instrument_prices"("instrument_id", "source", "quoted_at");

-- Под запрос последней цены: DESC, потому что берём максимум.
CREATE INDEX "instrument_prices_instrument_id_quoted_at_idx"
  ON "instrument_prices"("instrument_id", "quoted_at" DESC);

-- Цена не может быть отрицательной, а нулевая означает «торгов не было» —
-- такую точку писать незачем, это дырка в данных, а не цена.
ALTER TABLE "instrument_prices"
  ADD CONSTRAINT "instrument_prices_price_check" CHECK ("price" > 0);
