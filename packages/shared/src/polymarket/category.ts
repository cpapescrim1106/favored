import type { GammaTag } from "./types.js";

// Category keywords for classification
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  Politics: [
    "trump",
    "biden",
    "president",
    "election",
    "congress",
    "senate",
    "governor",
    "republican",
    "democrat",
    "vote",
    "political",
    "white house",
    "cabinet",
    "musk",
    "elon",
    "rfk",
    "kennedy",
    "pelosi",
    "desantis",
    "newsom",
  ],
  Sports: [
    "nfl",
    "nba",
    "mlb",
    "nhl",
    "super bowl",
    "championship",
    "playoffs",
    "world series",
    "player",
    "coach",
    "sports",
    "football",
    "basketball",
    "baseball",
    "hockey",
    "soccer",
    "ufc",
    "boxing",
    "f1",
    "formula 1",
    "nascar",
    "premier league",
    "la liga",
    "serie a",
    "bundesliga",
    "uefa",
    "fifa",
    "world cup",
    "champions league",
    "europa league",
    " fc ",
    " cf ",
    "united",
    "city fc",
    "real madrid",
    "barcelona",
    "liverpool",
    "chelsea",
    "arsenal",
    "tottenham",
    "juventus",
    "bayern",
    "psg",
    "tennis",
    "wimbledon",
    "us open",
    "grand slam",
    "olympics",
    "medal",
    "golf",
    "pga",
    "ncaa",
    "college football",
    "march madness",
    "mvp",
    "rookie",
    "stanley cup",
    "lombardi",
    "ligue 1",
    "eredivisie",
    "relegated",
    "promotion",
  ],
  Crypto: [
    "bitcoin",
    "btc",
    "ethereum",
    "eth",
    "crypto",
    "blockchain",
    "token",
    "defi",
    "nft",
    "solana",
    "sol",
    "dogecoin",
    "doge",
    "xrp",
    "cardano",
    "ada",
    "binance",
    "coinbase",
    "altcoin",
    "memecoin",
    "fdv",
    "airdrop",
    "aster",
    "sui ",
    "apt ",
    "arb ",
  ],
  Finance: [
    "stock",
    "fed",
    "interest rate",
    "inflation",
    "gdp",
    "economy",
    "s&p",
    "nasdaq",
    "dow",
    "trading",
    "earnings",
    "ipo",
    "merger",
    "acquisition",
    "tariff",
    "treasury",
    "bond",
    "recession",
    "bull market",
    "bear market",
    "market cap",
    "microstrategy",
    "doordash",
    "largest company",
  ],
  Tech: [
    "ai",
    "artificial intelligence",
    "google",
    "apple",
    "microsoft",
    "meta",
    "amazon",
    "openai",
    "chatgpt",
    "tech",
    "software",
    "iphone",
    "android",
    "tesla",
    "spacex",
    "nvidia",
    "semiconductor",
    "chip",
  ],
  Entertainment: [
    "movie",
    "film",
    "oscar",
    "grammy",
    "emmy",
    "box office",
    "netflix",
    "streaming",
    "celebrity",
    "music",
    "album",
    "golden globe",
    "academy award",
    "billboard",
    "spotify",
    "youtube",
    "tiktok",
    "viral",
    "tv show",
    "series",
    "actor",
    "actress",
    "director",
    "rotten tomatoes",
    "imdb",
    "mrbeast",
    "pewdiepie",
    "subscribers",
    "views",
    "influencer",
  ],
  Science: [
    "climate",
    "weather",
    "temperature",
    "nasa",
    "space",
    "research",
    "study",
    "discovery",
    "vaccine",
    "fda",
    "cdc",
    "pandemic",
    "virus",
    "disease",
    "earthquake",
    "hurricane",
    "hottest year",
    "hottest on record",
  ],
  World: [
    "ukraine",
    "russia",
    "china",
    "war",
    "conflict",
    "international",
    "global",
    "israel",
    "gaza",
    "palestine",
    "iran",
    "north korea",
    "syria",
    "nato",
    "eu",
    "european union",
    "brexit",
    "sanctions",
    "treaty",
    "embassy",
    "diplomat",
    "nobel",
    "epstein",
    "court of justice",
  ],
};

const CATEGORY_PATTERNS: [RegExp, string][] = [
  [/win on 20\\d{2}-\\d{2}-\\d{2}/i, "Sports"],
  [/vs\\.?\\s+\\w+.*(end in a draw|win)/i, "Sports"],
  [/(club|sk|fc)\\b.*win/i, "Sports"],
  [/gpt-?\\d|gemini|claude|llama|llm/i, "Tech"],
  [/hezbollah|hamas|taliban/i, "World"],
  [/pokemon|anime|manga/i, "Entertainment"],
  [/measles|flu |bird flu|h5n1|outbreak/i, "Science"],
];

const TAG_CATEGORY_MAP: Record<string, string> = {
  politics: "Politics",
  elections: "Politics",
  "us-politics": "Politics",
  sports: "Sports",
  crypto: "Crypto",
  cryptocurrencies: "Crypto",
  bitcoin: "Crypto",
  ethereum: "Crypto",
  finance: "Finance",
  economics: "Finance",
  fed: "Finance",
  tech: "Tech",
  technology: "Tech",
  science: "Science",
  health: "Science",
  culture: "Entertainment",
  entertainment: "Entertainment",
  "arts-entertainment": "Entertainment",
  "current-events": "World",
  world: "World",
  geopolitics: "World",
  international: "World",
};

const CATEGORY_NAMES = new Set([...Object.keys(CATEGORY_KEYWORDS), "Other"]);

function normalizeCategoryName(value?: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  for (const category of CATEGORY_NAMES) {
    if (category.toLowerCase() === normalized) {
      return category;
    }
  }
  return null;
}

function getTagSlug(tag: GammaTag): string | null {
  if (!tag.slug) return null;
  return tag.slug.trim().toLowerCase();
}

function isCarouselTag(tag: GammaTag): boolean {
  const legacy = (tag as { is_carousel?: boolean }).is_carousel;
  return Boolean(tag.isCarousel ?? legacy);
}

export function deriveCategoryFromTags(
  tags?: GammaTag[],
  fallbackCategory?: string | null
): string | null {
  if (tags && tags.length > 0) {
    const carouselTags = tags.filter(isCarouselTag);
    for (const tag of carouselTags) {
      const slug = getTagSlug(tag);
      if (slug && TAG_CATEGORY_MAP[slug]) {
        return TAG_CATEGORY_MAP[slug];
      }
    }

    for (const tag of tags) {
      const slug = getTagSlug(tag);
      if (slug && TAG_CATEGORY_MAP[slug]) {
        return TAG_CATEGORY_MAP[slug];
      }
    }
  }

  return normalizeCategoryName(fallbackCategory);
}

export function deriveCategory(
  title: string,
  question: string,
  seriesSlug?: string
): string {
  const text = `${title} ${question} ${seriesSlug || ""}`.toLowerCase();

  for (const [pattern, category] of CATEGORY_PATTERNS) {
    if (pattern.test(text)) {
      return category;
    }
  }

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((keyword) => text.includes(keyword))) {
      return category;
    }
  }

  return "Other";
}
