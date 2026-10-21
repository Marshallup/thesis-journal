-- CreateTable
CREATE TABLE "cash_ledger" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "account_id" UUID NOT NULL,
    "instrument_id" UUID,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(28,8) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "provider" TEXT NOT NULL,
    "external_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cash_ledger_account_id_occurred_at_idx" ON "cash_ledger"("account_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "cash_ledger_idempotency" ON "cash_ledger"("account_id", "provider", "external_id");
