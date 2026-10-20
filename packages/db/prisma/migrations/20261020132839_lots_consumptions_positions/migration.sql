-- CreateTable
CREATE TABLE "lots" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "account_id" UUID NOT NULL,
    "instrument_id" UUID NOT NULL,
    "open_trade_id" UUID NOT NULL,
    "qty_open" DECIMAL(38,18) NOT NULL,
    "qty_remaining" DECIMAL(38,18) NOT NULL,
    "price" DECIMAL(28,8) NOT NULL,
    "cost_open" DECIMAL(28,8) NOT NULL,
    "cost_remaining" DECIMAL(28,8) NOT NULL,
    "opened_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lot_consumptions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "account_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "trade_id" UUID NOT NULL,
    "qty" DECIMAL(38,18) NOT NULL,
    "cost" DECIMAL(28,8) NOT NULL,
    "realized_pnl" DECIMAL(28,8) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lot_consumptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "account_id" UUID NOT NULL,
    "instrument_id" UUID NOT NULL,
    "quantity" DECIMAL(38,18) NOT NULL,
    "cost_basis_total" DECIMAL(28,8) NOT NULL,
    "realized_pnl" DECIMAL(28,8) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lots_account_id_instrument_id_opened_at_idx" ON "lots"("account_id", "instrument_id", "opened_at");

-- CreateIndex
CREATE UNIQUE INDEX "lot_consumption_idempotency" ON "lot_consumptions"("lot_id", "trade_id");

-- CreateIndex
CREATE UNIQUE INDEX "positions_account_id_instrument_id_key" ON "positions"("account_id", "instrument_id");

-- AddForeignKey
ALTER TABLE "lots" ADD CONSTRAINT "lots_open_trade_id_fkey" FOREIGN KEY ("open_trade_id") REFERENCES "trades"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lot_consumptions" ADD CONSTRAINT "lot_consumptions_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lot_consumptions" ADD CONSTRAINT "lot_consumptions_trade_id_fkey" FOREIGN KEY ("trade_id") REFERENCES "trades"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
