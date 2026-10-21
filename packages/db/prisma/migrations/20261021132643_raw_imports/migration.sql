-- CreateTable
CREATE TABLE "raw_imports" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "account_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "file_hash" TEXT NOT NULL,
    "payload" BYTEA NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "raw_imports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "raw_import_idempotency" ON "raw_imports"("account_id", "file_hash");
