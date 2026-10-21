-- Отложенные операции: продажи, под которые в журнале ещё нет покупок.
-- Выгрузка Сбера ограничена годом, поэтому бумага, купленная раньше, в свежий
-- отчёт не попадает, и такая продажа — штатное состояние первого импорта.
-- До этой таблицы она жила только в ответе на запрос: ушёл с экрана — и система
-- о ней больше не помнит.
--
-- Это состояние, а не событие: строка существует, пока операцию нельзя
-- применить, и исчезает, когда применилась. Поэтому append-only-триггера, как
-- у cash_ledger, здесь нет.
CREATE TABLE "deferred_operations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "account_id" UUID NOT NULL,
    "import_id" UUID NOT NULL,
    "instrument_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "quantity" DECIMAL(38,18) NOT NULL,
    "missing" DECIMAL(38,18) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deferred_operations_pkey" PRIMARY KEY ("id")
);

-- Каскад: удалили импорт — отложенным операциям не на что ссылаться. В
-- отличие от сделок, терять тут нечего: набор пересчитывается из сохранённого
-- файла при каждом применении.
ALTER TABLE "deferred_operations"
  ADD CONSTRAINT "deferred_operations_import_id_fkey"
  FOREIGN KEY ("import_id") REFERENCES "raw_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "deferred_operation_identity"
  ON "deferred_operations"("import_id", "external_id");

CREATE INDEX "deferred_operations_account_id_instrument_id_idx"
  ON "deferred_operations"("account_id", "instrument_id");

-- Та же форма политики, что у остальных таблиц: путь к владельцу через accounts.
ALTER TABLE "deferred_operations" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "deferred_operations_isolation" ON "deferred_operations"
  USING ("account_id" IN (
    SELECT "id" FROM "accounts" WHERE "user_id" = current_setting('app.user_id')::uuid
  ));

-- Отложить можно только продажу: покупке лоты не нужны.
ALTER TABLE "deferred_operations"
  ADD CONSTRAINT "deferred_operations_side_check" CHECK ("side" = 'sell');
