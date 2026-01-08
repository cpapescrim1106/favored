import { prisma } from "../lib/db.js";
import { fetchActiveMarkets } from "@favored/shared/polymarket";
import { scoreCandidate, type ScoringInput } from "@favored/shared/scoring";
import { randomUUID } from "crypto";

// Category keywords for classification
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  "Politics": ["trump", "biden", "president", "election", "congress", "senate", "governor", "republican", "democrat", "vote", "political", "white house", "cabinet", "musk", "elon", "rfk", "kennedy", "pelosi", "desantis", "newsom"],
  "Sports": ["nfl", "nba", "mlb", "nhl", "super bowl", "championship", "playoffs", "world series", "player", "coach", "sports", "football", "basketball", "baseball", "hockey", "soccer", "ufc", "boxing", "f1", "formula 1", "nascar", "premier league", "la liga", "serie a", "bundesliga", "uefa", "fifa", "world cup", "champions league", "europa league", " fc ", " cf ", "united", "city fc", "real madrid", "barcelona", "liverpool", "chelsea", "arsenal", "tottenham", "juventus", "bayern", "psg", "tennis", "wimbledon", "us open", "grand slam", "olympics", "medal", "golf", "pga", "ncaa", "college football", "march madness", "mvp", "rookie", "stanley cup", "lombardi", "ligue 1", "eredivisie", "relegated", "promotion"],
  "Crypto": ["bitcoin", "btc", "ethereum", "eth", "crypto", "blockchain", "token", "defi", "nft", "solana", "sol", "dogecoin", "doge", "xrp", "cardano", "ada", "binance", "coinbase", "altcoin", "memecoin", "fdv", "airdrop", "aster", "sui ", "apt ", "arb "],
  "Finance": ["stock", "fed", "interest rate", "inflation", "gdp", "economy", "s&p", "nasdaq", "dow", "trading", "earnings", "ipo", "merger", "acquisition", "tariff", "treasury", "bond", "recession", "bull market", "bear market", "market cap", "microstrategy", "doordash", "largest company"],
  "Tech": ["ai", "artificial intelligence", "google", "apple", "microsoft", "meta", "amazon", "openai", "chatgpt", "tech", "software", "iphone", "android", "tesla", "spacex", "nvidia", "semiconductor", "chip"],
  "Entertainment": ["movie", "film", "oscar", "grammy", "emmy", "box office", "netflix", "streaming", "celebrity", "music", "album", "golden globe", "academy award", "billboard", "spotify", "youtube", "tiktok", "viral", "tv show", "series", "actor", "actress", "director", "rotten tomatoes", "imdb", "mrbeast", "pewdiepie", "subscribers", "views", "influencer"],
  "Science": ["climate", "weather", "temperature", "nasa", "space", "research", "study", "discovery", "vaccine", "fda", "cdc", "pandemic", "virus", "disease", "earthquake", "hurricane", "hottest year", "hottest on record"],
  "World": ["ukraine", "russia", "china", "war", "conflict", "international", "global", "israel", "gaza", "palestine", "iran", "north korea", "syria", "nato", "eu", "european union", "brexit", "sanctions", "treaty", "embassy", "diplomat", "nobel", "epstein", "court of justice"],
};

// Pattern-based rules (checked before keywords)
const CATEGORY_PATTERNS: [RegExp, string][] = [
  [/win on 20\d{2}-\d{2}-\d{2}/i, "Sports"], // "Will X win on 2026-01-10?"
  [/vs\.?\s+\w+.*(end in a draw|win)/i, "Sports"], // "X vs Y end in a draw"
  [/(club|sk|fc)\b.*win/i, "Sports"], // Club names with "win"
  [/gpt-?\d|gemini|claude|llama|llm/i, "Tech"], // AI models
  [/hezbollah|hamas|taliban/i, "World"], // Militant groups
  [/pokemon|anime|manga/i, "Entertainment"],
  [/measles|flu |bird flu|h5n1|outbreak/i, "Science"], // Health outbreaks
];

function deriveCategory(title: string, question: string, seriesSlug?: string): string {
  // Combine event title, question, and series slug for best matching
  const text = `${title} ${question} ${seriesSlug || ""}`.toLowerCase();

  // Check patterns first
  for (const [pattern, category] of CATEGORY_PATTERNS) {
    if (pattern.test(text)) {
      return category;
    }
  }

  // Then check keywords
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((kw) => text.includes(kw))) {
      return category;
    }
  }

  return "Other";
}

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

    // Fetch active markets from Gamma API
    const markets = await fetchActiveMarkets({
      minLiquidity: Number(config.minLiquidity),
      excludeCategories: config.excludedCategories,
    });

    console.log(`[Scan] Fetched ${markets.length} active markets`);

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

      // Skip markets without valid Yes/No pricing
      if (outcomes.length < 2 || prices.length < 2) continue;

      const yesIndex = outcomes.findIndex((o) => o === "Yes");
      const noIndex = outcomes.findIndex((o) => o === "No");

      if (yesIndex === -1 || noIndex === -1) continue;

      const yesPrice = prices[yesIndex];
      const noPrice = prices[noIndex];

      if (isNaN(yesPrice) || isNaN(noPrice)) continue;

      const spread = market.spread ?? Math.abs(1 - yesPrice - noPrice);

      // Derive category from event title, question, and seriesSlug
      const event = market.events?.[0];
      const category = deriveCategory(event?.title || "", market.question, event?.seriesSlug);

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
          liquidity: parseFloat(market.liquidity || "0"),
          volume24h: parseFloat(market.volume || "0"),
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
          liquidity: parseFloat(market.liquidity || "0"),
          volume24h: parseFloat(market.volume || "0"),
          lastUpdated: new Date(),
        },
      });
      marketsUpdated++;

      // Score both YES and NO sides
      for (const side of ["YES", "NO"] as const) {
        const price = side === "YES" ? yesPrice : noPrice;
        const impliedProb = price; // Price is the implied probability

        const scoringInput: ScoringInput = {
          impliedProb,
          spread,
          liquidity: parseFloat(market.liquidity || "0"),
          daysToClose,
          volume24h: parseFloat(market.volume || "0"),
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
              impliedProb,
              score: result.score,
              spreadOk: spread <= Number(config.maxSpread),
              liquidityOk: parseFloat(market.liquidity || "0") >= Number(config.minLiquidity),
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
