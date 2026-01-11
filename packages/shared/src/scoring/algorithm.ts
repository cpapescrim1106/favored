/**
 * Candidate Scoring Algorithm
 *
 * Scores market opportunities based on:
 * 1. Probability (sweet spot 75-85%)
 * 2. Spread tightness
 * 3. Liquidity depth
 * 4. Time to resolution
 *
 * Each component contributes 0-25 points for a max score of 100.
 */

export interface ScoringInput {
  impliedProb: number; // 0-1, derived from price
  spread: number; // Bid-ask spread as decimal
  liquidity: number; // USD liquidity
  daysToClose: number; // Days until market closes
  volume24h: number; // Recent 24h volume (for tiebreaking)
}

export interface ScoringConfig {
  minProb: number; // Default 0.65
  maxProb: number; // Default 0.90
  maxSpread: number; // Default 0.03 (3%)
  minLiquidity: number; // Default 5000
}

export interface ScoringResult {
  score: number; // 0-100
  eligible: boolean;
  reasons: string[];
  components: {
    probability: number;
    spread: number;
    liquidity: number;
    time: number;
  };
}

/**
 * Score a trading candidate
 *
 * Returns a score from 0-100 where higher is better.
 * A candidate must pass all gate checks to be eligible.
 */
export function scoreCandidate(
  input: ScoringInput,
  config: ScoringConfig
): ScoringResult {
  const reasons: string[] = [];

  // Gate checks (must pass all to be eligible)
  if (input.impliedProb < config.minProb) {
    return {
      score: 0,
      eligible: false,
      reasons: [`Probability ${(input.impliedProb * 100).toFixed(1)}% below minimum ${(config.minProb * 100).toFixed(0)}%`],
      components: { probability: 0, spread: 0, liquidity: 0, time: 0 },
    };
  }

  if (input.impliedProb > config.maxProb) {
    return {
      score: 0,
      eligible: false,
      reasons: [`Probability ${(input.impliedProb * 100).toFixed(1)}% above maximum ${(config.maxProb * 100).toFixed(0)}%`],
      components: { probability: 0, spread: 0, liquidity: 0, time: 0 },
    };
  }

  if (input.spread > config.maxSpread) {
    return {
      score: 0,
      eligible: false,
      reasons: [`Spread ${(input.spread * 100).toFixed(2)}% exceeds maximum ${(config.maxSpread * 100).toFixed(0)}%`],
      components: { probability: 0, spread: 0, liquidity: 0, time: 0 },
    };
  }

  if (input.liquidity < config.minLiquidity) {
    return {
      score: 0,
      eligible: false,
      reasons: [`Liquidity $${input.liquidity.toFixed(0)} below minimum $${config.minLiquidity}`],
      components: { probability: 0, spread: 0, liquidity: 0, time: 0 },
    };
  }

  // Scoring components (0-25 each, total 100)

  // 1. Probability score
  // Sweet spot is 75-85%. Higher probability = higher expected value
  // But 65-75% and 85-90% are still good
  let probScore: number;
  if (input.impliedProb >= 0.75 && input.impliedProb <= 0.85) {
    // Perfect range - full points
    probScore = 25;
  } else if (input.impliedProb >= 0.70 && input.impliedProb < 0.75) {
    // Good range - scale up
    probScore = 15 + ((input.impliedProb - 0.70) / 0.05) * 10;
  } else if (input.impliedProb > 0.85 && input.impliedProb <= 0.90) {
    // High probability - scale down slightly (less edge)
    probScore = 25 - ((input.impliedProb - 0.85) / 0.05) * 5;
  } else {
    // Edge cases (65-70%)
    probScore = 10 + ((input.impliedProb - 0.65) / 0.05) * 5;
  }

  // 2. Spread score
  // Lower spread = better execution, higher score
  const spreadScore = 25 * (1 - input.spread / config.maxSpread);

  // 3. Liquidity score
  // Log scale, capped at 25
  // $5k = ~0, $50k = ~12.5, $500k = ~25
  const liqRatio = input.liquidity / config.minLiquidity;
  const liqScore = Math.min(25, 25 * (Math.log10(liqRatio + 1) / 2));

  // 4. Time to resolution score
  // Sweet spot is 1-30 days (including same-day for live sports)
  // Too long (> 90 days) = capital tied up
  let timeScore: number;
  if (input.daysToClose >= 1 && input.daysToClose <= 30) {
    // Good range - full points (includes live sports)
    timeScore = 25;
  } else if (input.daysToClose > 30 && input.daysToClose <= 60) {
    // Acceptable range
    timeScore = 25 - ((input.daysToClose - 30) / 30) * 10;
  } else if (input.daysToClose > 60 && input.daysToClose <= 90) {
    // Getting long
    timeScore = 15 - ((input.daysToClose - 60) / 30) * 10;
  } else if (input.daysToClose > 90) {
    // Too long
    timeScore = Math.max(0, 5 - (input.daysToClose - 90) / 30);
  } else if (input.daysToClose > 0 && input.daysToClose < 1) {
    // Same day - live sports, still good
    timeScore = 20;
  } else {
    // Already resolved or invalid
    timeScore = 0;
  }

  const totalScore = Math.round(probScore + spreadScore + liqScore + timeScore);

  reasons.push(
    `Prob: ${probScore.toFixed(1)}/25`,
    `Spread: ${spreadScore.toFixed(1)}/25`,
    `Liq: ${liqScore.toFixed(1)}/25`,
    `Time: ${timeScore.toFixed(1)}/25`
  );

  return {
    score: totalScore,
    eligible: true,
    reasons,
    components: {
      probability: probScore,
      spread: spreadScore,
      liquidity: liqScore,
      time: timeScore,
    },
  };
}

/**
 * Default scoring configuration
 */
export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  minProb: 0.65,
  maxProb: 0.90,
  maxSpread: 0.03,
  minLiquidity: 5000,
};
