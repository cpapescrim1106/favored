-- CreateTable
CREATE TABLE "mm_candidates" (
    "marketId" TEXT NOT NULL,
    "venue" "Venue" NOT NULL,
    "midPrice" DECIMAL(10,6),
    "spreadTicks" INTEGER,
    "spreadPercent" DECIMAL(10,6),
    "topDepthNotional" DECIMAL(18,6),
    "depth3cBid" DECIMAL(18,6),
    "depth3cAsk" DECIMAL(18,6),
    "depth3cTotal" DECIMAL(18,6),
    "bookSlope" DECIMAL(10,6),
    "volume24h" DECIMAL(18,2),
    "queueSpeed" DECIMAL(10,6),
    "queueDepthRatio" DECIMAL(10,6),
    "hoursToEnd" DECIMAL(10,3),
    "liquidityScore" INTEGER NOT NULL,
    "flowScore" INTEGER NOT NULL,
    "timeScore" INTEGER NOT NULL,
    "priceZoneScore" INTEGER NOT NULL,
    "queueSpeedScore" INTEGER NOT NULL,
    "queueDepthScore" INTEGER NOT NULL,
    "totalScore" INTEGER NOT NULL,
    "eligible" BOOLEAN NOT NULL,
    "flags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "disqualifyReasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "scoredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mm_candidates_pkey" PRIMARY KEY ("marketId")
);

-- AddForeignKey
ALTER TABLE "mm_candidates" ADD CONSTRAINT "mm_candidates_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "mm_candidates_venue_idx" ON "mm_candidates"("venue");

-- CreateIndex
CREATE INDEX "mm_candidates_totalScore_idx" ON "mm_candidates"("totalScore");

-- CreateIndex
CREATE INDEX "mm_candidates_scoredAt_idx" ON "mm_candidates"("scoredAt");
