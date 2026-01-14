/**
 * Polymarket CLOB API Client with Surfshark Proxy Support
 *
 * Routes all traffic through a proxy to bypass geographic restrictions.
 * Implements geoblock checking as a safety measure.
 */

import { Wallet } from "ethers";
import { ClobClient } from "@polymarket/clob-client";
import { HttpsProxyAgent } from "https-proxy-agent";
import axios from "axios";
import dns from "dns";
import https from "https";
import type { LookupFunction } from "net";
import type {
  CLOBOrder,
  CLOBPosition,
  DataAPIPosition,
  OrderRequest,
  OrderResponse,
  BatchOrderRequest,
  BatchOrderResponse,
} from "./types.js";

const DATA_API_HOST = "https://data-api.polymarket.com";

const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137; // Polygon Mainnet
const GEOBLOCK_URL = "https://polymarket.com/api/geoblock";

// Maximum orders per batch (Polymarket limit)
export const MAX_BATCH_SIZE = 15;

export interface ClobCredentials {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
  privateKey: string;
  funderAddress?: string; // Polymarket proxy wallet address (holds funds)
}

export interface ProxyConfig {
  user: string;
  pass: string;
  server: string;
  port?: number;
}

const ipv4Lookup: LookupFunction = (hostname, options, callback) => {
  const normalized =
    typeof options === "object" && options !== null
      ? { ...options, family: 4 }
      : { family: 4 };
  dns.lookup(hostname, normalized, callback);
};

const ipv4Agent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  lookup: ipv4Lookup,
});

/**
 * CLOB API Client Configuration
 */
export interface CLOBConfig {
  apiKey?: string;
  apiSecret?: string;
  passphrase?: string;
  privateKey?: string;
  dryRun?: boolean;
}

let clobConfig: CLOBConfig = {
  dryRun: true, // Default to dry run mode
};

// Singleton client instance
let clobClientInstance: ClobClient | null = null;
let walletInstance: Wallet | null = null;
let proxyAgentInstance: HttpsProxyAgent<string> | null = null;

/**
 * Check if the current connection is geoblocked
 * Must be called BEFORE initializing the CLOB client
 */
export async function checkGeoblock(proxyAgent?: HttpsProxyAgent<string>): Promise<{
  blocked: boolean;
  country?: string;
  error?: string;
}> {
  try {
    const config = getAxiosConfig(proxyAgent);
    const response = await axios.get(GEOBLOCK_URL, {
      ...config,
      timeout: 10000,
    });

    const { blocked, country } = response.data;

    if (blocked) {
      return {
        blocked: true,
        country,
        error: `Access blocked from ${country || "your location"}`,
      };
    }

    return { blocked: false, country };
  } catch (error) {
    // If we can't check, assume blocked for safety
    return {
      blocked: true,
      error: `Geoblock check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Create a proxy agent from Surfshark credentials
 */
export function createProxyAgent(config: ProxyConfig): HttpsProxyAgent<string> {
  const port = config.port || 80;
  const proxyUrl = `http://${config.user}:${config.pass}@${config.server}:${port}`;
  return new HttpsProxyAgent(proxyUrl, {
    keepAlive: true,
    maxSockets: 50,
    maxFreeSockets: 10,
  });
}

/**
 * Get proxy configuration from environment variables
 */
export function getProxyConfigFromEnv(): ProxyConfig | null {
  const user = process.env.SURFSHARK_USER;
  const pass = process.env.SURFSHARK_PASS;
  const server = process.env.SURFSHARK_SERVER || process.env.SURFSHARK_HOST;

  if (!user || !pass || !server) {
    return null;
  }

  return {
    user,
    pass,
    server,
    port: parseInt(process.env.SURFSHARK_PORT || "80", 10),
  };
}

function getAxiosConfig(proxyAgent?: HttpsProxyAgent<string>): {
  httpsAgent: HttpsProxyAgent<string> | https.Agent;
  proxy: false;
} {
  return {
    httpsAgent: proxyAgent ?? ipv4Agent,
    proxy: false,
  };
}

/**
 * Configure the CLOB client
 */
export function configureCLOB(config: CLOBConfig): void {
  clobConfig = { ...clobConfig, ...config };
  // Reset singleton when config changes
  clobClientInstance = null;
  walletInstance = null;
}

/**
 * Check if the CLOB client is configured for real trading
 */
export function isCLOBConfigured(): boolean {
  return !!(
    (clobConfig.apiKey || process.env.POLYMARKET_API_KEY) &&
    (clobConfig.apiSecret || process.env.POLYMARKET_API_SECRET) &&
    (clobConfig.passphrase || process.env.POLYMARKET_PASSPHRASE) &&
    (clobConfig.privateKey || process.env.WALLET_PRIVATE_KEY)
  );
}

/**
 * Get CLOB credentials from environment variables or config
 */
export function getClobCredentials(): ClobCredentials | null {
  const apiKey = clobConfig.apiKey || process.env.POLYMARKET_API_KEY;
  const apiSecret = clobConfig.apiSecret || process.env.POLYMARKET_API_SECRET;
  const passphrase = clobConfig.passphrase || process.env.POLYMARKET_PASSPHRASE;
  const privateKey = clobConfig.privateKey || process.env.WALLET_PRIVATE_KEY;
  const funderAddress = process.env.POLYMARKET_FUNDER_ADDRESS;

  if (!apiKey || !apiSecret || !passphrase || !privateKey) {
    return null;
  }

  return { apiKey, apiSecret, passphrase, privateKey, funderAddress };
}

/**
 * Initialize the CLOB client with proxy support
 * This is the main entry point for getting a configured client
 *
 * @throws Error if geoblocked or credentials missing
 */
export async function initializeClobClient(): Promise<{
  client: ClobClient;
  wallet: Wallet;
  proxyAgent: HttpsProxyAgent<string> | null;
}> {
  // Return cached instance if available
  if (clobClientInstance && walletInstance) {
    return {
      client: clobClientInstance,
      wallet: walletInstance,
      proxyAgent: proxyAgentInstance,
    };
  }

  // Get credentials
  const creds = getClobCredentials();
  if (!creds) {
    throw new Error(
      "Missing CLOB credentials. Set POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_PASSPHRASE, and WALLET_PRIVATE_KEY"
    );
  }

  // Check if geoblock check should be skipped (for testing only)
  const skipGeoblock = process.env.SKIP_GEOBLOCK_CHECK === "true";

  // Get proxy config (optional)
  const proxyConfig = getProxyConfigFromEnv();

  if (skipGeoblock) {
    console.log("[CLOB] WARNING: Geoblock check SKIPPED (SKIP_GEOBLOCK_CHECK=true)");
    console.log("[CLOB] Real orders will fail if you're in a blocked region!");
    proxyAgentInstance = null;
  } else {
    // First, check if we're geoblocked without proxy (VPN might already be active)
    console.log("[CLOB] Checking geoblock status...");
    const directGeoCheck = await checkGeoblock();

    if (!directGeoCheck.blocked) {
      // Not blocked - VPN is likely active system-wide
      console.log(`[CLOB] Direct connection OK (country: ${directGeoCheck.country || "unknown"})`);
      proxyAgentInstance = null;
    } else if (proxyConfig) {
      // Try through proxy
      console.log(`[CLOB] Direct blocked (${directGeoCheck.country}), trying proxy: ${proxyConfig.server}`);
      proxyAgentInstance = createProxyAgent(proxyConfig);

      const proxyGeoCheck = await checkGeoblock(proxyAgentInstance);
      if (proxyGeoCheck.blocked) {
        throw new Error(`Geoblocked even through proxy: ${proxyGeoCheck.error}`);
      }
      console.log(`[CLOB] Proxy geoblock check passed (country: ${proxyGeoCheck.country || "unknown"})`);
    } else {
      // Blocked and no proxy configured
      throw new Error(
        `Geoblocked from ${directGeoCheck.country}. Either:\n` +
        `  1. Enable Surfshark VPN on your system, or\n` +
        `  2. Configure a proxy in .env (SURFSHARK_USER, SURFSHARK_PASS, SURFSHARK_SERVER)\n` +
        `  3. Set SKIP_GEOBLOCK_CHECK=true to test without VPN (orders will fail)`
      );
    }
  }

  // Create wallet signer
  walletInstance = new Wallet(creds.privateKey);
  console.log(`[CLOB] Signer wallet address: ${walletInstance.address}`);

  // Build client options with credentials
  const clientCreds = {
    key: creds.apiKey,
    secret: creds.apiSecret,
    passphrase: creds.passphrase,
  };

  // Determine signature type and funder address
  // If POLYMARKET_FUNDER_ADDRESS is set, use Gnosis Safe signature type (2)
  // This is needed when trading with a Polymarket proxy wallet
  const funderAddress = creds.funderAddress;
  const signatureType = funderAddress ? 2 : 0; // 2 = POLY_GNOSIS_SAFE, 0 = EOA

  if (funderAddress) {
    console.log(`[CLOB] Funder (proxy wallet): ${funderAddress}`);
    console.log(`[CLOB] Signature type: POLY_GNOSIS_SAFE (2)`);
  } else {
    console.log(`[CLOB] No funder address set - using direct EOA mode`);
    console.log(`[CLOB] Signature type: EOA (0)`);
  }

  // Initialize CLOB client with signature type and funder
  clobClientInstance = new ClobClient(
    CLOB_HOST,
    CHAIN_ID,
    walletInstance,
    clientCreds,
    signatureType,
    funderAddress
  );

  // Try to inject proxy agent into the client's http instance if it exists
  if (proxyAgentInstance) {
    const clientAny = clobClientInstance as unknown as Record<string, unknown>;
    if (clientAny.http && typeof clientAny.http === "object") {
      const httpClient = clientAny.http as { defaults?: Record<string, unknown> };
      if (httpClient.defaults) {
        httpClient.defaults.httpsAgent = proxyAgentInstance;
        httpClient.defaults.proxy = false;
      }
    }
  }

  return {
    client: clobClientInstance,
    wallet: walletInstance,
    proxyAgent: proxyAgentInstance,
  };
}

/**
 * Test the CLOB connection
 */
export async function testClobConnection(): Promise<{
  success: boolean;
  walletAddress?: string;
  openOrdersCount?: number;
  country?: string;
  usingProxy?: boolean;
  error?: string;
}> {
  try {
    const { client, wallet, proxyAgent } = await initializeClobClient();

    // Test by fetching open orders
    const openOrders = await client.getOpenOrders();

    return {
      success: true,
      walletAddress: wallet.address,
      openOrdersCount: openOrders.length,
      usingProxy: !!proxyAgent,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Fetch current positions
 */
export async function fetchPositions(): Promise<CLOBPosition[]> {
  if (clobConfig.dryRun || !isCLOBConfigured()) {
    console.log("[CLOB] Dry run mode - returning empty positions");
    return [];
  }

  try {
    const { client } = await initializeClobClient();
    // The client doesn't have a direct getPositions method
    // Positions are tracked locally or via chain data
    return [];
  } catch (error) {
    console.error("[CLOB] Failed to fetch positions:", error);
    return [];
  }
}

/**
 * Fetch active orders
 */
export async function fetchActiveOrders(): Promise<CLOBOrder[] | null> {
  if (clobConfig.dryRun || !isCLOBConfigured()) {
    console.log("[CLOB] Dry run mode - returning empty orders");
    return [];
  }

  try {
    const { client } = await initializeClobClient();
    const orders = await client.getOpenOrders();

    return orders.map((order) => ({
      id: order.id,
      asset_id: order.asset_id,
      maker_address: order.maker_address,
      side: order.side as "BUY" | "SELL",
      price: order.price,
      size: order.original_size || order.size_matched || "0",
      outcome: order.outcome as "Yes" | "No",
      status: "live" as const,
      created_at: String(order.created_at || new Date().toISOString()),
    }));
  } catch (error) {
    console.error("[CLOB] Failed to fetch orders:", error);
    return null;
  }
}

/**
 * Place a single order
 *
 * @param order - Order parameters including optional orderType and postOnly
 * @param order.orderType - GTC (default), GTD, FOK, or FAK
 * @param order.postOnly - If true, order will be rejected if it would cross the spread
 * @param order.expiration - Unix timestamp for GTD orders
 */
export async function placeOrder(order: OrderRequest): Promise<OrderResponse> {
  const orderType = order.orderType || "GTC";

  console.log("[CLOB] Order request:", {
    tokenId: order.tokenId.slice(0, 8) + "...",
    side: order.side,
    price: order.price,
    size: order.size,
    orderType,
    postOnly: order.postOnly,
  });

  if (clobConfig.dryRun || !isCLOBConfigured()) {
    console.log("[CLOB] Dry run mode - order not placed");
    return {
      success: true,
      orderId: `dry-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      status: "simulated",
    };
  }

  try {
    const { client } = await initializeClobClient();

    // Import OrderType enum from the client
    const { OrderType, AssetType } = await import("@polymarket/clob-client");

    // Map our string type to the client's enum
    const orderTypeEnum = {
      GTC: OrderType.GTC,
      GTD: OrderType.GTD,
      FOK: OrderType.FOK,
      FAK: OrderType.FAK,
    }[orderType];

    // Build order options
    const orderOptions: {
      tokenID: string;
      side: import("@polymarket/clob-client").Side;
      price: number;
      size: number;
      expiration?: number;
    } = {
      tokenID: order.tokenId,
      side: order.side as unknown as import("@polymarket/clob-client").Side,
      price: order.price,
      size: order.size,
    };

    // Add expiration for GTD orders
    if (orderType === "GTD" && order.expiration) {
      orderOptions.expiration = order.expiration;
    }

    // Refresh allowance cache and verify before placing order
    // NOTE: updateBalanceAllowance() refreshes Polymarket's cached view of on-chain allowances,
    // it does NOT set approvals. Approvals must exist on-chain from the funder (Safe) wallet.
    const ALLOWANCE_RETRIES = 3;
    const ALLOWANCE_RETRY_DELAY_MS = 500;

    for (let attempt = 0; attempt < ALLOWANCE_RETRIES; attempt++) {
      try {
        if (order.side === "SELL") {
          // SELL orders need CONDITIONAL token approval from Safe to CTF/Exchange
          await client.updateBalanceAllowance({
            asset_type: AssetType.CONDITIONAL,
            token_id: order.tokenId,
          });
        } else {
          // BUY orders need COLLATERAL (USDC) approval from Safe to Exchange
          await client.updateBalanceAllowance({
            asset_type: AssetType.COLLATERAL,
          });
        }

        // Brief delay to let cache propagate
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 100));
        }

        // Verify allowance is sufficient
        const assetType = order.side === "SELL" ? AssetType.CONDITIONAL : AssetType.COLLATERAL;
        const balanceCheck = await client.getBalanceAllowance({
          asset_type: assetType,
          ...(order.side === "SELL" ? { token_id: order.tokenId } : {}),
        });

        // Debug: log raw response for CONDITIONAL tokens
        console.log(`[CLOB] Balance/Allowance response for ${order.side === "SELL" ? "CONDITIONAL" : "COLLATERAL"}:`, JSON.stringify(balanceCheck, null, 2));

        // Handle response format - for CONDITIONAL tokens, approvals field indicates ERC1155 operator approval
        // For COLLATERAL, allowances map indicates ERC20 allowances to different contracts
        const rawResponse = balanceCheck as unknown as {
          allowance?: string;
          allowances?: Record<string, string>;
          approvals?: Record<string, boolean>;
          balance?: string;
        };

        let allowance = 0;
        let isApproved = false;

        // For CONDITIONAL (ERC1155): check approvals map for setApprovalForAll status
        if (rawResponse?.approvals && typeof rawResponse.approvals === "object") {
          // Check if any exchange contract has approval
          isApproved = Object.values(rawResponse.approvals).some((v) => v === true);
          // For comparison purposes, set allowance to infinity if approved
          if (isApproved) {
            allowance = Number.MAX_SAFE_INTEGER;
          }
          console.log(`[CLOB] CONDITIONAL approvals:`, rawResponse.approvals, `isApproved: ${isApproved}`);
        }

        // For COLLATERAL (ERC20): check allowance/allowances
        if (rawResponse?.allowance) {
          allowance = parseFloat(rawResponse.allowance);
        } else if (rawResponse?.allowances && typeof rawResponse.allowances === "object") {
          const allowanceValues = Object.values(rawResponse.allowances);
          if (allowanceValues.length > 0) {
            allowance = Math.min(...allowanceValues.map((v) => parseFloat(v) || 0));
          }
        }

        const balance = parseFloat(rawResponse?.balance || "0");
        const USDC_DECIMALS = 1e6;
        const requiredAmount = order.side === "BUY"
          ? (order.price * order.size) * USDC_DECIMALS
          : order.size * USDC_DECIMALS;

        // For SELL orders with CONDITIONAL tokens, check approval status
        // For BUY orders with COLLATERAL, check numerical allowance
        const hasApproval = order.side === "SELL"
          ? (isApproved || allowance >= requiredAmount)
          : (allowance >= requiredAmount);

        if (hasApproval && balance >= requiredAmount) {
          console.log(`[CLOB] Allowance OK: ${order.side === "SELL" ? `approved=${isApproved}` : (allowance / USDC_DECIMALS).toFixed(2)}, balance: ${(balance / USDC_DECIMALS).toFixed(2)}`);
          break;
        }

        console.warn(`[CLOB] Allowance check attempt ${attempt + 1}: allowance=${(allowance / USDC_DECIMALS).toFixed(2)}, balance=${(balance / USDC_DECIMALS).toFixed(2)}, required=${(requiredAmount / USDC_DECIMALS).toFixed(2)}`);

        if (attempt < ALLOWANCE_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, ALLOWANCE_RETRY_DELAY_MS * (attempt + 1)));
        }
      } catch (allowanceError) {
        console.error(`[CLOB] Allowance refresh attempt ${attempt + 1} failed:`, allowanceError);
        if (attempt < ALLOWANCE_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, ALLOWANCE_RETRY_DELAY_MS * (attempt + 1)));
        }
      }
    }

    // Create and sign order
    const signedOrder = await client.createOrder(orderOptions);

    // Log SignedOrder fields for debugging (per Polymarket docs recommendations)
    // This helps diagnose "not enough balance / allowance" errors
    console.log("[CLOB] SignedOrder:", {
      maker: signedOrder.maker,
      signer: signedOrder.signer,
      signatureType: signedOrder.signatureType,
      tokenId: signedOrder.tokenId?.substring(0, 20) + "...",
      makerAmount: signedOrder.makerAmount,
      takerAmount: signedOrder.takerAmount,
      side: signedOrder.side,
    });

    // Post the order with type and postOnly options
    const response = await client.postOrder(signedOrder, orderTypeEnum, order.postOnly);

    return {
      success: true,
      orderId: response.orderID,
      status: response.status,
      takingAmount: response.takingAmount,
      makingAmount: response.makingAmount,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("[CLOB] Order failed:", errorMessage);

    // Check for specific error types
    if (errorMessage.includes("would cross")) {
      return {
        success: false,
        error: "Order rejected: would cross spread (postOnly)",
        status: "rejected",
      };
    }

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Place multiple orders in a batch
 * Splits into chunks of MAX_BATCH_SIZE
 */
export async function placeBatchOrders(
  request: BatchOrderRequest
): Promise<BatchOrderResponse> {
  const results: OrderResponse[] = [];
  const errors: string[] = [];

  // Split orders into batches
  const batches: OrderRequest[][] = [];
  for (let i = 0; i < request.orders.length; i += MAX_BATCH_SIZE) {
    batches.push(request.orders.slice(i, i + MAX_BATCH_SIZE));
  }

  console.log(
    `[CLOB] Placing ${request.orders.length} orders in ${batches.length} batches`
  );

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    console.log(`[CLOB] Processing batch ${batchIndex + 1}/${batches.length}`);

    for (const order of batch) {
      try {
        const result = await placeOrder(order);
        results.push(result);
        if (!result.success && result.error) {
          errors.push(result.error);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        results.push({ success: false, error: errorMessage });
        errors.push(errorMessage);
      }
    }

    // Small delay between batches to avoid rate limiting
    if (batchIndex < batches.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  return {
    success: errors.length === 0,
    results,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Get order details by ID
 * Returns the order with its current status and fill information
 */
export type OrderDetails = {
  id: string;
  status: string;
  size_matched: string;
  original_size: string;
  price: string;
  side: string;
  outcome: string;
  asset_id: string;
};

export type OrderResult =
  | { status: "ok"; order: OrderDetails }
  | { status: "not_found" }
  | { status: "error"; message: string };

export async function getOrder(orderId: string): Promise<OrderResult> {
  try {
    const { client } = await initializeClobClient();
    const order = await client.getOrder(orderId);
    if (!order) return { status: "not_found" };

    return {
      status: "ok",
      order: {
        id: order.id,
        status: order.status || "unknown",
        size_matched: order.size_matched || "0",
        original_size: order.original_size || "0",
        price: order.price || "0",
        side: order.side || "",
        outcome: order.outcome || "",
        asset_id: order.asset_id || "",
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not found|404/i.test(message)) {
      return { status: "not_found" };
    }
    console.error(`[CLOB] Failed to get order ${orderId}:`, error);
    return { status: "error", message };
  }
}

/**
 * Cancel an order
 */
export async function cancelOrder(orderId: string): Promise<boolean> {
  console.log(`[CLOB] Cancel order request: ${orderId}`);

  if (clobConfig.dryRun || !isCLOBConfigured()) {
    console.log("[CLOB] Dry run mode - order not cancelled");
    return true;
  }

  try {
    const { client } = await initializeClobClient();
    await client.cancelOrder({ orderID: orderId });
    return true;
  } catch (error) {
    console.error("[CLOB] Cancel order failed:", error);
    return false;
  }
}

/**
 * Cancel all orders for a market
 */
export async function cancelAllOrders(marketId?: string): Promise<number> {
  console.log(`[CLOB] Cancel all orders request${marketId ? ` for market ${marketId}` : ""}`);

  if (clobConfig.dryRun || !isCLOBConfigured()) {
    console.log("[CLOB] Dry run mode - orders not cancelled");
    return 0;
  }

  try {
    const { client } = await initializeClobClient();
    const result = await client.cancelAll();
    return result?.canceledOrders?.length || 0;
  } catch (error) {
    console.error("[CLOB] Cancel all orders failed:", error);
    return 0;
  }
}

/**
 * Get orderbook for a market
 */
export async function getOrderbook(
  tokenId: string
): Promise<{ bids: Array<{ price: number; size: number }>; asks: Array<{ price: number; size: number }> }> {
  try {
    const config = getAxiosConfig(proxyAgentInstance ?? undefined);

    const response = await axios.get(`${CLOB_HOST}/book?token_id=${tokenId}`, config);
    const data = response.data;

    // CLOB API returns prices and sizes as strings - convert to numbers
    const bids = (data.bids || []).map((level: { price: string; size: string }) => ({
      price: Number(level.price),
      size: Number(level.size),
    }));
    const asks = (data.asks || []).map((level: { price: string; size: string }) => ({
      price: Number(level.price),
      size: Number(level.size),
    }));

    bids.sort((a: { price: number }, b: { price: number }) => b.price - a.price);
    asks.sort((a: { price: number }, b: { price: number }) => a.price - b.price);

    return { bids, asks };
  } catch (error) {
    console.error(`Failed to fetch orderbook for ${tokenId}:`, error);
    return { bids: [], asks: [] };
  }
}

/**
 * Get best bid and ask prices for a token
 * Returns null for prices if no liquidity on that side
 */
export async function getBestPrices(tokenId: string): Promise<{
  bestBid: number | null;
  bestAsk: number | null;
  bidDepth: number;
  askDepth: number;
}> {
  const book = await getOrderbook(tokenId);

  // Bids are sorted descending (highest first)
  const bestBid = book.bids.length > 0 ? Number(book.bids[0].price) : null;
  // Asks are sorted ascending (lowest first)
  const bestAsk = book.asks.length > 0 ? Number(book.asks[0].price) : null;

  // Calculate depth at best price
  const bidDepth = book.bids.length > 0 ? Number(book.bids[0].size) : 0;
  const askDepth = book.asks.length > 0 ? Number(book.asks[0].size) : 0;

  return { bestBid, bestAsk, bidDepth, askDepth };
}

/**
 * Calculate maker price for an order
 * For BUY: use best bid (rest on bid side)
 * For SELL: use best ask (rest on ask side)
 *
 * @param tokenId - The token to trade
 * @param side - BUY or SELL
 * @param fallbackPrice - Price to use if no liquidity exists
 * @param tickSize - Minimum tick size (default 0.01)
 */
export async function getMakerPrice(
  tokenId: string,
  side: "BUY" | "SELL",
  fallbackPrice: number,
  tickSize: number = 0.01
): Promise<{ price: number; depth: number }> {
  const { bestBid, bestAsk, bidDepth, askDepth } = await getBestPrices(tokenId);

  if (side === "BUY") {
    // For buying, rest at the bid
    if (bestBid !== null) {
      return { price: bestBid, depth: bidDepth };
    }
    // No bid exists - place slightly below ask or use fallback
    if (bestAsk !== null) {
      return { price: Math.max(tickSize, bestAsk - tickSize), depth: 0 };
    }
    return { price: fallbackPrice, depth: 0 };
  } else {
    // For selling, rest at the ask
    if (bestAsk !== null) {
      return { price: bestAsk, depth: askDepth };
    }
    // No ask exists - place slightly above bid or use fallback
    if (bestBid !== null) {
      return { price: Math.min(1 - tickSize, bestBid + tickSize), depth: 0 };
    }
    return { price: fallbackPrice, depth: 0 };
  }
}

/**
 * Get midpoint price for a token
 */
export async function getMidpointPrice(tokenId: string): Promise<number | null> {
  try {
    const config = getAxiosConfig(proxyAgentInstance ?? undefined);

    const response = await axios.get(`${CLOB_HOST}/midpoint?token_id=${tokenId}`, config);
    return response.data.mid ? parseFloat(response.data.mid) : null;
  } catch (error) {
    console.error(`Failed to fetch midpoint for ${tokenId}:`, error);
    return null;
  }
}

/**
 * Get spread for a token
 */
export async function getSpread(tokenId: string): Promise<number | null> {
  try {
    const config = getAxiosConfig(proxyAgentInstance ?? undefined);

    const response = await axios.get(`${CLOB_HOST}/spread?token_id=${tokenId}`, config);
    return response.data.spread ? parseFloat(response.data.spread) : null;
  } catch (error) {
    console.error(`Failed to fetch spread for ${tokenId}:`, error);
    return null;
  }
}

/**
 * Get USDC balance available for trading
 * Returns balance in USDC (converted from micro-units)
 */
export async function getBalance(): Promise<{ balance: number; allowance: number } | null> {
  try {
    const { client } = await initializeClobClient();
    const { AssetType } = await import("@polymarket/clob-client");

    const response = await client.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });

    // USDC has 6 decimals, so divide by 1e6 to get actual USD value
    const USDC_DECIMALS = 1e6;

    // Handle both singular 'allowance' and plural 'allowances' response formats
    // The API returns allowances as a map of contract address -> allowance amount
    // TypeScript types only show 'allowance' but runtime response may have 'allowances'
    const rawResponse = response as unknown as {
      allowance?: string;
      allowances?: Record<string, string>;
      balance?: string;
    };

    let totalAllowance = 0;
    if (rawResponse.allowance) {
      totalAllowance = parseFloat(rawResponse.allowance);
    } else if (rawResponse.allowances && typeof rawResponse.allowances === "object") {
      // Sum up all allowances (or take the minimum for safety)
      const allowanceValues = Object.values(rawResponse.allowances);
      if (allowanceValues.length > 0) {
        // Use minimum allowance as the effective allowance
        totalAllowance = Math.min(...allowanceValues.map((v) => parseFloat(v) || 0));
      }
    }

    return {
      balance: parseFloat(rawResponse.balance || "0") / USDC_DECIMALS,
      allowance: totalAllowance / USDC_DECIMALS,
    };
  } catch (error) {
    // Silently fail - balance will show as "—"
    return null;
  }
}

/**
 * Get current positions from Polymarket Data API
 * This returns accurate current positions directly from Polymarket
 *
 * @param userAddress - The wallet address to fetch positions for (uses POLYMARKET_FUNDER_ADDRESS if not provided)
 * @param options.sizeThreshold - Minimum position size (default: 0)
 * @param options.limit - Maximum number of positions to return (default: 100)
 */
export async function getPositions(
  userAddress?: string,
  options?: { sizeThreshold?: number; limit?: number }
): Promise<DataAPIPosition[] | null> {
  const address = userAddress || process.env.POLYMARKET_FUNDER_ADDRESS;
  if (!address) {
    console.error("[CLOB] No user address provided and POLYMARKET_FUNDER_ADDRESS not set");
    return null;
  }

  const sizeThreshold = options?.sizeThreshold ?? 0;
  const limit = options?.limit ?? 100;

  try {
    const config = getAxiosConfig(proxyAgentInstance ?? undefined);

    const url = `${DATA_API_HOST}/positions?user=${address}&sizeThreshold=${sizeThreshold}&limit=${limit}`;
    const response = await axios.get(url, config);

    if (!Array.isArray(response.data)) {
      console.error("[CLOB] Unexpected response from Data API positions endpoint");
      return null;
    }

    return response.data as DataAPIPosition[];
  } catch (error) {
    console.error("[CLOB] Failed to fetch positions from Data API:", error);
    return null;
  }
}

// Re-export the client type
export type { ClobClient };
