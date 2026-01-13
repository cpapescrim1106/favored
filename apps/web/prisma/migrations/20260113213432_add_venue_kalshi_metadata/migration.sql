-- CreateEnum
CREATE TYPE "Venue" AS ENUM ('POLYMARKET', 'KALSHI');

-- CreateEnum
CREATE TYPE "BasketStatus" AS ENUM ('DRAFT', 'PENDING', 'EXECUTING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('OPEN', 'CLOSING', 'CLOSED', 'RESOLVED');

-- CreateTable
CREATE TABLE "markets" (
    "id" TEXT NOT NULL,
    "venue" "Venue" NOT NULL DEFAULT 'POLYMARKET',
    "slug" TEXT NOT NULL,
    "eventSlug" TEXT,
    "eventTicker" TEXT,
    "question" TEXT NOT NULL,
    "category" TEXT,
    "endDate" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "yesPrice" DECIMAL(10,6),
    "noPrice" DECIMAL(10,6),
    "spread" DECIMAL(10,6),
    "liquidity" DECIMAL(18,2),
    "volume24h" DECIMAL(18,2),
    "lastUpdated" TIMESTAMP(3),
    "clobTokenIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "priceLevelStructure" TEXT,
    "priceRanges" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "markets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidates" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "outcomeName" TEXT,
    "impliedProb" DECIMAL(10,6) NOT NULL,
    "score" DECIMAL(10,4) NOT NULL,
    "spreadOk" BOOLEAN NOT NULL,
    "liquidityOk" BOOLEAN NOT NULL,
    "scanId" TEXT NOT NULL,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "baskets" (
    "id" TEXT NOT NULL,
    "status" "BasketStatus" NOT NULL DEFAULT 'DRAFT',
    "totalStake" DECIMAL(18,2) NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "batchCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executedAt" TIMESTAMP(3),

    CONSTRAINT "baskets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "basket_items" (
    "id" TEXT NOT NULL,
    "basketId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "stake" DECIMAL(18,2) NOT NULL,
    "limitPrice" DECIMAL(10,6) NOT NULL,
    "snapshotPrice" DECIMAL(10,6) NOT NULL,
    "orderId" TEXT,
    "fillPrice" DECIMAL(10,6),
    "fillAmount" DECIMAL(18,2),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "basket_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "side" VARCHAR(3) NOT NULL,
    "size" DECIMAL(18,6) NOT NULL,
    "avgEntry" DECIMAL(10,6) NOT NULL,
    "totalCost" DECIMAL(18,2) NOT NULL,
    "markPrice" DECIMAL(10,6),
    "unrealizedPnl" DECIMAL(18,2),
    "takeProfitPrice" DECIMAL(10,6),
    "status" "PositionStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "price" DECIMAL(10,6) NOT NULL,
    "size" DECIMAL(18,6) NOT NULL,
    "value" DECIMAL(18,2) NOT NULL,
    "orderId" TEXT,
    "fee" DECIMAL(18,6),
    "executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_makers" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "targetSpread" DECIMAL(5,4) NOT NULL,
    "orderSize" DECIMAL(18,6) NOT NULL,
    "maxInventory" DECIMAL(18,6) NOT NULL,
    "skewFactor" DECIMAL(5,4) NOT NULL,
    "quotingPolicy" TEXT NOT NULL DEFAULT 'touch',
    "bidOffsetTicks" INTEGER,
    "askOffsetTicks" INTEGER,
    "yesInventory" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "noInventory" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "realizedPnl" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "avgYesCost" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "avgNoCost" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "minTimeToResolution" INTEGER NOT NULL DEFAULT 24,
    "volatilityPauseUntil" TIMESTAMP(3),
    "lastQuoteAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_makers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_maker_orders" (
    "id" TEXT NOT NULL,
    "marketMakerId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "tier" INTEGER NOT NULL DEFAULT 0,
    "orderId" TEXT NOT NULL,
    "clientOrderId" TEXT,
    "orderGroupId" TEXT,
    "tokenId" TEXT NOT NULL,
    "price" DECIMAL(10,6) NOT NULL,
    "size" DECIMAL(18,6) NOT NULL,
    "lastMatchedSize" DECIMAL(18,6),
    "verified" BOOLEAN NOT NULL DEFAULT true,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_maker_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_maker_fills" (
    "id" TEXT NOT NULL,
    "marketMakerId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "clientOrderId" TEXT,
    "price" DECIMAL(10,6) NOT NULL,
    "size" DECIMAL(18,6) NOT NULL,
    "value" DECIMAL(18,6) NOT NULL,
    "fee" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "realizedPnl" DECIMAL(18,6),
    "filledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_maker_fills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_history" (
    "id" TEXT NOT NULL,
    "marketMakerId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "outcome" TEXT,
    "side" TEXT,
    "price" DECIMAL(10,6),
    "size" DECIMAL(18,6),
    "orderId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "logs" (
    "id" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "config" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "minProb" DECIMAL(5,4) NOT NULL DEFAULT 0.65,
    "maxProb" DECIMAL(5,4) NOT NULL DEFAULT 0.90,
    "maxSpread" DECIMAL(5,4) NOT NULL DEFAULT 0.03,
    "minLiquidity" DECIMAL(18,2) NOT NULL DEFAULT 5000,
    "defaultStake" DECIMAL(18,2) NOT NULL DEFAULT 50,
    "maxStakePerMarket" DECIMAL(18,2) NOT NULL DEFAULT 200,
    "maxExposurePerMarket" DECIMAL(18,2) NOT NULL DEFAULT 500,
    "maxExposurePerCategory" DECIMAL(18,2) NOT NULL DEFAULT 2000,
    "maxOpenPositions" INTEGER NOT NULL DEFAULT 50,
    "maxTotalExposure" DECIMAL(18,2) NOT NULL DEFAULT 10000,
    "takeProfitThreshold" DECIMAL(5,4) NOT NULL DEFAULT 0.95,
    "maxSlippage" DECIMAL(5,4) NOT NULL DEFAULT 0.02,
    "killSwitchActive" BOOLEAN NOT NULL DEFAULT false,
    "scanInterval" INTEGER NOT NULL DEFAULT 10,
    "excludedCategories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mmDefaultSpread" DECIMAL(5,4) NOT NULL DEFAULT 0.04,
    "mmDefaultOrderSize" DECIMAL(18,6) NOT NULL DEFAULT 100,
    "mmDefaultMaxInventory" DECIMAL(18,6) NOT NULL DEFAULT 500,
    "mmDefaultSkewFactor" DECIMAL(5,4) NOT NULL DEFAULT 0.04,
    "mmDefaultQuotingPolicy" TEXT NOT NULL DEFAULT 'touch',
    "mmRefreshThreshold" DECIMAL(5,4) NOT NULL DEFAULT 0.01,
    "mmMinTimeToResolution" INTEGER NOT NULL DEFAULT 24,
    "mmEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mmTierCount" INTEGER NOT NULL DEFAULT 2,
    "mmTierBidOffsets" TEXT NOT NULL DEFAULT '1,2',
    "mmTierAskOffsets" TEXT NOT NULL DEFAULT '0,1',
    "mmTierSizes" TEXT NOT NULL DEFAULT '0.5,0.5',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "markets_active_idx" ON "markets"("active");

-- CreateIndex
CREATE INDEX "markets_category_idx" ON "markets"("category");

-- CreateIndex
CREATE INDEX "markets_endDate_idx" ON "markets"("endDate");

-- CreateIndex
CREATE UNIQUE INDEX "markets_venue_slug_key" ON "markets"("venue", "slug");

-- CreateIndex
CREATE INDEX "candidates_scanId_idx" ON "candidates"("scanId");

-- CreateIndex
CREATE INDEX "candidates_scannedAt_idx" ON "candidates"("scannedAt");

-- CreateIndex
CREATE INDEX "candidates_score_idx" ON "candidates"("score");

-- CreateIndex
CREATE INDEX "baskets_status_idx" ON "baskets"("status");

-- CreateIndex
CREATE INDEX "baskets_createdAt_idx" ON "baskets"("createdAt");

-- CreateIndex
CREATE INDEX "basket_items_basketId_idx" ON "basket_items"("basketId");

-- CreateIndex
CREATE INDEX "basket_items_status_idx" ON "basket_items"("status");

-- CreateIndex
CREATE INDEX "positions_status_idx" ON "positions"("status");

-- CreateIndex
CREATE INDEX "positions_openedAt_idx" ON "positions"("openedAt");

-- CreateIndex
CREATE UNIQUE INDEX "positions_marketId_side_key" ON "positions"("marketId", "side");

-- CreateIndex
CREATE INDEX "trades_positionId_idx" ON "trades"("positionId");

-- CreateIndex
CREATE INDEX "trades_executedAt_idx" ON "trades"("executedAt");

-- CreateIndex
CREATE UNIQUE INDEX "market_makers_marketId_key" ON "market_makers"("marketId");

-- CreateIndex
CREATE INDEX "market_makers_active_idx" ON "market_makers"("active");

-- CreateIndex
CREATE INDEX "market_maker_orders_orderId_idx" ON "market_maker_orders"("orderId");

-- CreateIndex
CREATE INDEX "market_maker_orders_marketMakerId_outcome_side_idx" ON "market_maker_orders"("marketMakerId", "outcome", "side");

-- CreateIndex
CREATE UNIQUE INDEX "market_maker_orders_marketMakerId_outcome_side_tier_key" ON "market_maker_orders"("marketMakerId", "outcome", "side", "tier");

-- CreateIndex
CREATE INDEX "market_maker_fills_marketMakerId_idx" ON "market_maker_fills"("marketMakerId");

-- CreateIndex
CREATE INDEX "market_maker_fills_filledAt_idx" ON "market_maker_fills"("filledAt");

-- CreateIndex
CREATE INDEX "quote_history_marketMakerId_idx" ON "quote_history"("marketMakerId");

-- CreateIndex
CREATE INDEX "quote_history_createdAt_idx" ON "quote_history"("createdAt");

-- CreateIndex
CREATE INDEX "logs_category_idx" ON "logs"("category");

-- CreateIndex
CREATE INDEX "logs_level_idx" ON "logs"("level");

-- CreateIndex
CREATE INDEX "logs_createdAt_idx" ON "logs"("createdAt");

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "basket_items" ADD CONSTRAINT "basket_items_basketId_fkey" FOREIGN KEY ("basketId") REFERENCES "baskets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "basket_items" ADD CONSTRAINT "basket_items_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_makers" ADD CONSTRAINT "market_makers_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_maker_orders" ADD CONSTRAINT "market_maker_orders_marketMakerId_fkey" FOREIGN KEY ("marketMakerId") REFERENCES "market_makers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_maker_fills" ADD CONSTRAINT "market_maker_fills_marketMakerId_fkey" FOREIGN KEY ("marketMakerId") REFERENCES "market_makers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_history" ADD CONSTRAINT "quote_history_marketMakerId_fkey" FOREIGN KEY ("marketMakerId") REFERENCES "market_makers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
