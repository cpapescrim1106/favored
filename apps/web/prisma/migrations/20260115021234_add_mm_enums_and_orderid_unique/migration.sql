-- Add enum types for market maker fields
DO $$ BEGIN
  CREATE TYPE "MarketOutcome" AS ENUM ('YES', 'NO');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "OrderSide" AS ENUM ('BID', 'ASK');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "FillSide" AS ENUM ('BUY', 'SELL');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "FillEventStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Convert string columns to enums
ALTER TABLE "market_maker_orders"
  ALTER COLUMN "outcome" TYPE "MarketOutcome" USING ("outcome"::"MarketOutcome"),
  ALTER COLUMN "side" TYPE "OrderSide" USING ("side"::"OrderSide");

ALTER TABLE "market_maker_fills"
  ALTER COLUMN "outcome" TYPE "MarketOutcome" USING ("outcome"::"MarketOutcome"),
  ALTER COLUMN "side" TYPE "FillSide" USING ("side"::"FillSide");

ALTER TABLE "market_maker_fill_events"
  ALTER COLUMN "outcome" TYPE "MarketOutcome" USING ("outcome"::"MarketOutcome"),
  ALTER COLUMN "side" TYPE "FillSide" USING ("side"::"FillSide"),
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "FillEventStatus" USING ("status"::"FillEventStatus"),
  ALTER COLUMN "status" SET DEFAULT 'PENDING'::"FillEventStatus";

-- Enforce unique order IDs across market maker orders
DROP INDEX IF EXISTS "market_maker_orders_orderId_idx";
CREATE UNIQUE INDEX "market_maker_orders_orderId_key" ON "market_maker_orders"("orderId");
