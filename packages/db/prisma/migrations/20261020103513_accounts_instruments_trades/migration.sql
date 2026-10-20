-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "base_currency" CHAR(3) NOT NULL,
    "is_iis" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "instruments" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "symbol" TEXT NOT NULL,
    "class" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "instruments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "account_id" UUID NOT NULL,
    "instrument_id" UUID NOT NULL,
    "side" TEXT NOT NULL,
    "quantity" DECIMAL(38,18) NOT NULL,
    "price" DECIMAL(28,8) NOT NULL,
    "fee" DECIMAL(28,8) NOT NULL,
    "fee_currency" CHAR(3) NOT NULL,
    "executed_at" TIMESTAMPTZ(6) NOT NULL,
    "provider" TEXT NOT NULL,
    "external_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "accounts_user_id_idx" ON "accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "instruments_symbol_class_key" ON "instruments"("symbol", "class");

-- CreateIndex
CREATE INDEX "trades_account_id_executed_at_idx" ON "trades"("account_id", "executed_at");

-- CreateIndex
CREATE UNIQUE INDEX "trade_idempotency" ON "trades"("account_id", "provider", "external_id");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
