// @ts-nocheck
import { fetchEvents } from "../packages/shared/src/polymarket/gamma.ts";
import {
  deriveCategory,
  deriveCategoryFromTags,
} from "../packages/shared/src/polymarket/category.ts";

const REQUEST_DELAY_MS = 100;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const limit = Number(process.env.LIMIT || "100");
  const pages = Number(process.env.PAGES || "3");
  const includeClosed = process.env.CLOSED === "true";

  const categoryCounts = new Map();
  const otherSamples = [];
  let totalMarkets = 0;

  let offset = 0;

  for (let page = 0; page < pages; page += 1) {
    const events = await fetchEvents({
      active: true,
      closed: includeClosed,
      archived: false,
      limit,
      offset,
      order: "id",
      ascending: false,
    });

    if (events.length === 0) break;

    for (const event of events) {
      for (const market of event.markets || []) {
        const seriesSlug = event.seriesSlug || event.slug;
        const tagSource = event.tags && event.tags.length > 0 ? event.tags : market.tags;
        const tagCategory = deriveCategoryFromTags(
          tagSource,
          event.category || market.category
        );
        const category =
          tagCategory ?? deriveCategory(event.title || "", market.question || "", seriesSlug);

        totalMarkets += 1;
        categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);

        if (category === "Other" && otherSamples.length < 10) {
          const tagList = (tagSource || [])
            .map((tag) => tag.slug || tag.label)
            .filter(Boolean)
            .slice(0, 6);
          otherSamples.push({
            event: event.slug,
            market: market.slug,
            tags: tagList,
          });
        }
      }
    }

    offset += limit;
    await delay(REQUEST_DELAY_MS);
  }

  const otherCount = categoryCounts.get("Other") || 0;
  const otherPct = totalMarkets === 0 ? 0 : (otherCount / totalMarkets) * 100;

  console.log(
    `[tags-verify] markets=${totalMarkets} other=${otherCount} (${otherPct.toFixed(2)}%)`
  );

  const sorted = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [category, count] of sorted) {
    console.log(`[tags-verify] ${category}: ${count}`);
  }

  if (otherSamples.length > 0) {
    console.log("[tags-verify] other samples:");
    for (const sample of otherSamples) {
      const tags = sample.tags.length > 0 ? ` tags=${sample.tags.join(",")}` : "";
      console.log(`- event=${sample.event} market=${sample.market}${tags}`);
    }
  }
}

main().catch((error) => {
  console.error("[tags-verify] Failed:", error);
  process.exit(1);
});
