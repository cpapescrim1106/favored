import { prisma } from "../lib/db.js";
import {
  deriveCategory,
  deriveCategoryFromTags,
  fetchAllActiveMarkets,
} from "@favored/shared/polymarket";
import { scoreCandidate, type ScoringInput } from "@favored/shared/scoring";
import { randomUUID } from "crypto";


export async function runScanJob(): Promise<void> {
  const scanId = randomUUID();
  const startTime = Date.now();

  console.log(`[Scan] Starting scan ${scanId}...`);

  try {
    // Get current config
    const config = await prisma.config.findUnique({
      where: { id: "singleton" },
    });

    if (!config) {
      console.log("[Scan] No config found, skipping scan");
      return;
    }

    // Fetch active markets via events-first crawl
    const markets = await fetchAllActiveMarkets();

    console.log(`[Scan] Fetched ${markets.length} active markets from /events`);

    const minLiquidity = Number(config.minLiquidity);
    const excludedCategories = (config.excludedCategories || [])
      .filter(Boolean)
      .map((exc) => exc.toLowerCase());

    let candidatesCreated = 0;
    let marketsUpdated = 0;

    for (const market of markets) {
      // Parse outcomes and prices from JSON strings
      let outcomes: string[];
      let prices: number[];

      try {
        outcomes = JSON.parse(market.outcomes || "[]");
        prices = JSON.parse(market.outcomePrices || "[]").map(Number);
      } catch {
        continue; // Skip markets with invalid data
      }

      // Skip markets without valid pricing
      if (outcomes.length < 2 || prices.length < 2) continue;

      // Handle both Yes/No markets AND team vs team markets (like sports)
      let yesPrice: number;
      let noPrice: number;
      let isTeamMarket = false;

      const yesIndex = outcomes.findIndex((o) => o === "Yes");
      const noIndex = outcomes.findIndex((o) => o === "No");

      // Track outcome names for display
      let yesOutcomeName: string;
      let noOutcomeName: string;

      if (yesIndex !== -1 && noIndex !== -1) {
        // Standard Yes/No market
        yesPrice = prices[yesIndex];
        noPrice = prices[noIndex];
        yesOutcomeName = "Yes";
        noOutcomeName = "No";
      } else if (outcomes.length === 2) {
        // Team vs team market (e.g., "Maple Leafs" vs "Flyers")
        // Treat first outcome as YES side, second as NO side
        yesPrice = prices[0];
        noPrice = prices[1];
        yesOutcomeName = outcomes[0];
        noOutcomeName = outcomes[1];
        isTeamMarket = true;
      } else {
        continue; // Skip multi-outcome markets
      }

      if (isNaN(yesPrice) || isNaN(noPrice)) continue;

      const spread = market.spread ?? Math.abs(1 - yesPrice - noPrice);

      // Derive category from event title, question, and seriesSlug
      const event = market.events?.[0];
      const seriesSlug = event?.seriesSlug || event?.slug;
      const tagSource = (event?.tags && event.tags.length > 0)
        ? event.tags
        : market.tags;
      const tagCategory = deriveCategoryFromTags(tagSource, event?.category || market.category);
      const category =
        tagCategory ?? deriveCategory(event?.title || "", market.question, seriesSlug);

      if (excludedCategories.length > 0) {
        const categoryText = category.toLowerCase();
        if (excludedCategories.some((exc) => categoryText.includes(exc))) {
          continue;
        }
      }

      const liquidityValue = parseFloat(market.liquidity || "0");
      if (minLiquidity && liquidityValue < minLiquidity) continue;

      const volume24h = parseFloat(market.volume || "0");

      // Calculate days to close
      const endDate = market.endDate ? new Date(market.endDate) : null;
      const daysToClose = endDate
        ? Math.max(0, (endDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        : 365; // Default to 1 year if no end date

      // Upsert market data
      await prisma.market.upsert({
        where: { id: market.id },
        update: {
          slug: market.slug,
          question: market.question,
          category,
          endDate: endDate,
          active: market.active && !market.closed,
          yesPrice: yesPrice,
          noPrice: noPrice,
          spread: spread,
          liquidity: liquidityValue,
          volume24h: volume24h,
          lastUpdated: new Date(),
        },
        create: {
          id: market.id,
          slug: market.slug,
          question: market.question,
          category,
          endDate: endDate,
          active: market.active && !market.closed,
          yesPrice: yesPrice,
          noPrice: noPrice,
          spread: spread,
          liquidity: liquidityValue,
          volume24h: volume24h,
          lastUpdated: new Date(),
        },
      });
      marketsUpdated++;

      // Score both YES and NO sides
      for (const side of ["YES", "NO"] as const) {
        const price = side === "YES" ? yesPrice : noPrice;
        const outcomeName = side === "YES" ? yesOutcomeName : noOutcomeName;
        const impliedProb = price; // Price is the implied probability

        const scoringInput: ScoringInput = {
          impliedProb,
          spread,
          liquidity: liquidityValue,
          daysToClose,
          volume24h: volume24h,
        };

        const result = scoreCandidate(scoringInput, {
          minProb: Number(config.minProb),
          maxProb: Number(config.maxProb),
          maxSpread: Number(config.maxSpread),
          minLiquidity: Number(config.minLiquidity),
        });

        if (result.eligible) {
          await prisma.candidate.create({
            data: {
              marketId: market.id,
              side,
              outcomeName,
              impliedProb,
              score: result.score,
              spreadOk: spread <= Number(config.maxSpread),
              liquidityOk: liquidityValue >= Number(config.minLiquidity),
              scanId,
              scannedAt: new Date(),
            },
          });
          candidatesCreated++;
        }
      }
    }

    const duration = Date.now() - startTime;

    // Log scan completion
    await prisma.log.create({
      data: {
        level: "INFO",
        category: "SCAN",
        message: `Scan completed: ${marketsUpdated} markets, ${candidatesCreated} candidates`,
        metadata: {
          scanId,
          marketsUpdated,
          candidatesCreated,
          durationMs: duration,
        },
      },
    });

    console.log(
      `[Scan] Completed in ${duration}ms: ${marketsUpdated} markets, ${candidatesCreated} candidates`
    );

    // Clean up old candidates (keep last 24 hours)
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const deleted = await prisma.candidate.deleteMany({
      where: { scannedAt: { lt: cutoff } },
    });
    if (deleted.count > 0) {
      console.log(`[Scan] Cleaned up ${deleted.count} old candidates`);
    }
  } catch (error) {
    console.error("[Scan] Error:", error);
    await prisma.log.create({
      data: {
        level: "ERROR",
        category: "SCAN",
        message: `Scan failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: {
          scanId,
          stack: error instanceof Error ? error.stack : undefined,
        },
      },
    });
    throw error;
  }
}
