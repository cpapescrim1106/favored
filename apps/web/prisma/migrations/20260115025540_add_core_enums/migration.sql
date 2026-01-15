-- Add enum types for candidate/basket/position/trade/quote history
DO $$ BEGIN
  CREATE TYPE "BasketItemStatus" AS ENUM ('pending', 'submitted', 'filled', 'partial', 'failed', 'cancelled');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "TradeType" AS ENUM ('ENTRY', 'EXIT');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "QuoteSide" AS ENUM ('BID', 'ASK', 'BUY', 'SELL');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Candidate side -> MarketOutcome
ALTER TABLE "candidates"
  ALTER COLUMN "side" TYPE "MarketOutcome" USING ("side"::"MarketOutcome");

-- Basket item side/status
ALTER TABLE "basket_items"
  ALTER COLUMN "side" TYPE "MarketOutcome" USING ("side"::"MarketOutcome"),
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "BasketItemStatus" USING ("status"::"BasketItemStatus"),
  ALTER COLUMN "status" SET DEFAULT 'pending'::"BasketItemStatus";

-- Position side
ALTER TABLE "positions"
  ALTER COLUMN "side" TYPE "MarketOutcome" USING ("side"::"MarketOutcome");

-- Trade type/side
ALTER TABLE "trades"
  ALTER COLUMN "type" TYPE "TradeType" USING ("type"::"TradeType"),
  ALTER COLUMN "side" TYPE "FillSide" USING ("side"::"FillSide");

-- Quote history outcome/side
ALTER TABLE "quote_history"
  ALTER COLUMN "outcome" TYPE "MarketOutcome" USING ("outcome"::"MarketOutcome"),
  ALTER COLUMN "side" TYPE "QuoteSide" USING ("side"::"QuoteSide");
