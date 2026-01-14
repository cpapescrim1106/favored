CREATE TABLE "market_maker_fill_events" (
    "id" TEXT NOT NULL,
    "marketMakerId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "price" DECIMAL(10,6) NOT NULL,
    "size" DECIMAL(18,6) NOT NULL,
    "value" DECIMAL(18,6) NOT NULL,
    "matchedTotal" DECIMAL(18,6) NOT NULL,
    "source" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "metadata" JSONB,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    CONSTRAINT "market_maker_fill_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "market_maker_fill_events_orderId_matchedTotal_key"
ON "market_maker_fill_events"("orderId", "matchedTotal");

CREATE INDEX "market_maker_fill_events_marketMakerId_status_idx"
ON "market_maker_fill_events"("marketMakerId", "status");

CREATE INDEX "market_maker_fill_events_observedAt_idx"
ON "market_maker_fill_events"("observedAt");

ALTER TABLE "market_maker_fill_events"
ADD CONSTRAINT "market_maker_fill_events_marketMakerId_fkey"
FOREIGN KEY ("marketMakerId") REFERENCES "market_makers"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
