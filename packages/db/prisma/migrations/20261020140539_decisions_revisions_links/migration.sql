-- CreateTable
CREATE TABLE "decisions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "account_id" UUID NOT NULL,
    "instrument_id" UUID NOT NULL,
    "side" TEXT NOT NULL,
    "thesis" TEXT NOT NULL,
    "horizon_days" INTEGER NOT NULL,
    "conviction" INTEGER NOT NULL,
    "mood" TEXT NOT NULL,
    "invalidator" TEXT,
    "tags" TEXT[],
    "free_text" TEXT,
    "context_snapshot" JSONB,
    "post_factum" BOOLEAN NOT NULL DEFAULT false,
    "unrealized" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decision_revisions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "account_id" UUID NOT NULL,
    "decision_id" UUID NOT NULL,
    "thesis" TEXT NOT NULL,
    "horizon_days" INTEGER NOT NULL,
    "conviction" INTEGER NOT NULL,
    "mood" TEXT NOT NULL,
    "invalidator" TEXT,
    "tags" TEXT[],
    "free_text" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decision_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decision_trades" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "account_id" UUID NOT NULL,
    "decision_id" UUID NOT NULL,
    "trade_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decision_trades_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "decisions_account_id_instrument_id_created_at_idx" ON "decisions"("account_id", "instrument_id", "created_at");

-- CreateIndex
CREATE INDEX "decision_revisions_decision_id_created_at_idx" ON "decision_revisions"("decision_id", "created_at");

-- CreateIndex
CREATE INDEX "decision_trades_trade_id_idx" ON "decision_trades"("trade_id");

-- CreateIndex
CREATE UNIQUE INDEX "decision_trade_link" ON "decision_trades"("decision_id", "trade_id");

-- AddForeignKey
ALTER TABLE "decision_revisions" ADD CONSTRAINT "decision_revisions_decision_id_fkey" FOREIGN KEY ("decision_id") REFERENCES "decisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_trades" ADD CONSTRAINT "decision_trades_decision_id_fkey" FOREIGN KEY ("decision_id") REFERENCES "decisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_trades" ADD CONSTRAINT "decision_trades_trade_id_fkey" FOREIGN KEY ("trade_id") REFERENCES "trades"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
