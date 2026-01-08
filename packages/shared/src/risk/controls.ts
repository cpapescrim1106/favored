/**
 * Risk Control Module
 *
 * Provides pre-execution validation for baskets:
 * - Kill switch
 * - Position count limits
 * - Exposure limits (per market, category, total)
 * - Slippage guards
 */

export interface RiskConfig {
  killSwitchActive: boolean;
  maxOpenPositions: number;
  maxExposurePerMarket: number;
  maxExposurePerCategory: number;
  maxTotalExposure: number;
  maxSlippage: number;
}

export interface Position {
  id: string;
  marketId: string;
  side: string;
  totalCost: number;
  status: string;
  market: {
    category: string | null;
  };
}

export interface RiskBasketItem {
  marketId: string;
  marketSlug: string;
  side: string;
  stake: number;
  snapshotPrice: number;
  category: string;
}

export interface Basket {
  items: RiskBasketItem[];
  totalStake: number;
  itemCount: number;
}

export interface RiskCheck {
  passed: boolean;
  code: string;
  reason?: string;
}

export interface RiskValidationResult {
  valid: boolean;
  checks: RiskCheck[];
  errors: string[];
  warnings: string[];
}

/**
 * Check if kill switch is active
 */
export function checkKillSwitch(config: RiskConfig): RiskCheck {
  if (config.killSwitchActive) {
    return {
      passed: false,
      code: "KILL_SWITCH",
      reason: "Kill switch is active - all trading disabled",
    };
  }
  return { passed: true, code: "KILL_SWITCH" };
}

/**
 * Check if adding basket would exceed max positions
 */
export function checkMaxPositions(
  positions: Position[],
  basket: Basket,
  config: RiskConfig
): RiskCheck {
  const openCount = positions.filter((p) => p.status === "OPEN").length;
  const newCount = basket.itemCount;
  const totalCount = openCount + newCount;

  if (totalCount > config.maxOpenPositions) {
    return {
      passed: false,
      code: "MAX_POSITIONS",
      reason: `Would exceed max positions: ${openCount} existing + ${newCount} new = ${totalCount} > ${config.maxOpenPositions} max`,
    };
  }
  return { passed: true, code: "MAX_POSITIONS" };
}

/**
 * Check per-market exposure limits
 */
export function checkMarketExposure(
  positions: Position[],
  basket: Basket,
  config: RiskConfig
): RiskCheck[] {
  const checks: RiskCheck[] = [];

  // Calculate current exposure per market
  const marketExposure: Record<string, number> = {};
  for (const pos of positions.filter((p) => p.status === "OPEN")) {
    marketExposure[pos.marketId] = (marketExposure[pos.marketId] || 0) + pos.totalCost;
  }

  // Check each basket item
  for (const item of basket.items) {
    const existing = marketExposure[item.marketId] || 0;
    const total = existing + item.stake;

    if (total > config.maxExposurePerMarket) {
      checks.push({
        passed: false,
        code: "MARKET_EXPOSURE",
        reason: `${item.marketSlug}: exposure $${existing.toFixed(0)} + $${item.stake.toFixed(0)} = $${total.toFixed(0)} > $${config.maxExposurePerMarket} max`,
      });
    } else {
      checks.push({ passed: true, code: "MARKET_EXPOSURE" });
    }
  }

  return checks;
}

/**
 * Check per-category exposure limits
 */
export function checkCategoryExposure(
  positions: Position[],
  basket: Basket,
  config: RiskConfig
): RiskCheck[] {
  const checks: RiskCheck[] = [];

  // Calculate current exposure per category
  const categoryExposure: Record<string, number> = {};
  for (const pos of positions.filter((p) => p.status === "OPEN")) {
    const category = pos.market.category || "uncategorized";
    categoryExposure[category] = (categoryExposure[category] || 0) + pos.totalCost;
  }

  // Add basket items to category exposure
  const newCategoryExposure: Record<string, number> = { ...categoryExposure };
  for (const item of basket.items) {
    newCategoryExposure[item.category] =
      (newCategoryExposure[item.category] || 0) + item.stake;
  }

  // Check each category
  const checkedCategories = new Set<string>();
  for (const item of basket.items) {
    if (checkedCategories.has(item.category)) continue;
    checkedCategories.add(item.category);

    const total = newCategoryExposure[item.category] || 0;
    if (total > config.maxExposurePerCategory) {
      checks.push({
        passed: false,
        code: "CATEGORY_EXPOSURE",
        reason: `Category ${item.category}: total exposure $${total.toFixed(0)} > $${config.maxExposurePerCategory} max`,
      });
    }
  }

  if (checks.length === 0) {
    checks.push({ passed: true, code: "CATEGORY_EXPOSURE" });
  }

  return checks;
}

/**
 * Check total exposure limit
 */
export function checkTotalExposure(
  positions: Position[],
  basket: Basket,
  config: RiskConfig
): RiskCheck {
  const currentExposure = positions
    .filter((p) => p.status === "OPEN")
    .reduce((sum, p) => sum + p.totalCost, 0);

  const newExposure = basket.totalStake;
  const totalExposure = currentExposure + newExposure;

  if (totalExposure > config.maxTotalExposure) {
    return {
      passed: false,
      code: "TOTAL_EXPOSURE",
      reason: `Total exposure $${currentExposure.toFixed(0)} + $${newExposure.toFixed(0)} = $${totalExposure.toFixed(0)} > $${config.maxTotalExposure} max`,
    };
  }
  return { passed: true, code: "TOTAL_EXPOSURE" };
}

/**
 * Check slippage between snapshot price and current price
 */
export function checkSlippage(
  snapshotPrice: number,
  currentPrice: number,
  maxSlippage: number
): RiskCheck {
  if (snapshotPrice === 0) {
    return {
      passed: false,
      code: "SLIPPAGE",
      reason: "Invalid snapshot price (zero)",
    };
  }

  const slippage = Math.abs(currentPrice - snapshotPrice) / snapshotPrice;

  if (slippage > maxSlippage) {
    return {
      passed: false,
      code: "SLIPPAGE",
      reason: `Price moved ${(slippage * 100).toFixed(2)}% since basket build (max ${(maxSlippage * 100).toFixed(0)}%)`,
    };
  }
  return { passed: true, code: "SLIPPAGE" };
}

/**
 * Validate basket execution with all risk checks
 */
export async function validateBasketExecution(
  basket: Basket,
  positions: Position[],
  config: RiskConfig,
  getCurrentPrice?: (marketId: string, side: string) => Promise<number | null>
): Promise<RiskValidationResult> {
  const checks: RiskCheck[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Kill switch check
  const killCheck = checkKillSwitch(config);
  checks.push(killCheck);
  if (!killCheck.passed) errors.push(killCheck.reason!);

  // 2. Max positions check
  const posCheck = checkMaxPositions(positions, basket, config);
  checks.push(posCheck);
  if (!posCheck.passed) errors.push(posCheck.reason!);

  // 3. Market exposure checks
  const marketChecks = checkMarketExposure(positions, basket, config);
  checks.push(...marketChecks);
  for (const check of marketChecks) {
    if (!check.passed) errors.push(check.reason!);
  }

  // 4. Category exposure checks
  const catChecks = checkCategoryExposure(positions, basket, config);
  checks.push(...catChecks);
  for (const check of catChecks) {
    if (!check.passed) errors.push(check.reason!);
  }

  // 5. Total exposure check
  const totalCheck = checkTotalExposure(positions, basket, config);
  checks.push(totalCheck);
  if (!totalCheck.passed) errors.push(totalCheck.reason!);

  // 6. Slippage checks (if price fetcher provided)
  if (getCurrentPrice) {
    for (const item of basket.items) {
      try {
        const currentPrice = await getCurrentPrice(item.marketId, item.side);
        if (currentPrice !== null) {
          const slipCheck = checkSlippage(
            item.snapshotPrice,
            currentPrice,
            config.maxSlippage
          );
          checks.push(slipCheck);
          if (!slipCheck.passed) {
            errors.push(`${item.marketSlug}: ${slipCheck.reason}`);
          }
        } else {
          warnings.push(`${item.marketSlug}: Could not fetch current price for slippage check`);
        }
      } catch (error) {
        warnings.push(
          `${item.marketSlug}: Slippage check failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    checks,
    errors,
    warnings,
  };
}

/**
 * Default risk configuration
 */
export const DEFAULT_RISK_CONFIG: RiskConfig = {
  killSwitchActive: false,
  maxOpenPositions: 50,
  maxExposurePerMarket: 500,
  maxExposurePerCategory: 2000,
  maxTotalExposure: 10000,
  maxSlippage: 0.02,
};
