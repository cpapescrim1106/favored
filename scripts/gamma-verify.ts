// @ts-nocheck
const GAMMA_BASE_URL = "https://gamma-api.polymarket.com";

async function fetchEventBySlugFallback(slug) {
  const response = await fetch(`${GAMMA_BASE_URL}/events/slug/${slug}`);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Gamma API error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function main() {
  const gamma = await import("../packages/shared/src/polymarket/gamma.ts");
  const minLiquidity = Number(process.env.MIN_LIQUIDITY || "500000");
  const limit = Number(process.env.LIMIT || "20");
  const slug =
    process.env.EVENT_SLUG ||
    "which-companies-added-to-sp-500-in-q1-2026";

  console.log(`[verify] minLiquidity=${minLiquidity} limit=${limit}`);

  const markets = await gamma.fetchMarkets({
    closed: false,
    minLiquidity,
    limit,
  });
  const belowThreshold = markets.filter(
    (market) => parseFloat(market.liquidity || "0") < minLiquidity
  ).length;
  console.log(
    `[verify] fetchMarkets(minLiquidity) -> ${markets.length} markets, ${belowThreshold} below threshold`
  );

  const searchResults = await gamma.searchMarkets("sp 500");
  console.log(
    `[verify] searchMarkets("sp 500") -> ${searchResults.length} markets`
  );

  const fetchEventBySlug =
    typeof gamma.fetchEventBySlug === "function"
      ? gamma.fetchEventBySlug
      : fetchEventBySlugFallback;
  const event = await fetchEventBySlug(slug);
  console.log(
    `[verify] event slug "${slug}" -> ${event ? "found" : "not found"}, markets=${event?.markets?.length || 0}`
  );

  if (typeof gamma.fetchAllActiveMarkets === "function") {
    const allMarkets = await gamma.fetchAllActiveMarkets();
    console.log(
      `[verify] fetchAllActiveMarkets -> ${allMarkets.length} markets`
    );
  } else {
    const regularMarkets = await gamma.fetchActiveMarkets({});
    const sportsMarkets = await gamma.fetchActiveSportsMarkets({});
    const marketMap = new Map();
    for (const market of regularMarkets) marketMap.set(market.id, market);
    for (const market of sportsMarkets) marketMap.set(market.id, market);
    console.log(
      `[verify] fetchActiveMarkets + fetchActiveSportsMarkets -> ${marketMap.size} unique markets (${regularMarkets.length} regular, ${sportsMarkets.length} sports)`
    );
  }
}

main().catch((error) => {
  console.error("[verify] Failed:", error);
  process.exit(1);
});
