import {
  ConnectionStatus,
  RealTimeDataClient,
  type Message,
} from "@polymarket/real-time-data-client";
import dns from "dns";
import { getClobCredentials, getPositions } from "@favored/shared";
import { prisma } from "../lib/db.js";
import {
  logQuoteAction,
  processFill,
  verifyFillAgainstChain,
} from "../jobs/market-making.js";

const DEFAULT_WS_HOST = "wss://ws-live-data.polymarket.com";
const DEFAULT_PING_INTERVAL_MS = 5000;
const DEFAULT_TOKEN_REFRESH_MS = 5 * 60 * 1000;
const DEFAULT_CHAIN_CACHE_MS = 5000;
const DEFAULT_METRICS_INTERVAL_MS = 60 * 1000;
const DEFAULT_RECONNECT_BASE_MS = 2000;
const DEFAULT_RECONNECT_MAX_MS = 60000;
const DEFAULT_RECONNECT_JITTER_MS = 250;
const DEFAULT_RECONNECT_MIN_GAP_MS = 1000;
const DEFAULT_RECONNECT_RESET_MS = 20000;

const TERMINAL_STATUSES = new Set([
  "MATCHED",
  "CANCELLED",
  "CANCELED",
  "EXPIRED",
]);
const LIVE_STATUSES = new Set(["LIVE", "OPEN"]);

const BASKET_STATUS_RANK: Record<string, number> = {
  pending: 0,
  submitted: 1,
  partial: 2,
  cancelled: 3,
  filled: 4,
  failed: 5,
  simulated: -1,
};

interface ClobUserOrderPayload {
  id?: string;
  status?: string;
  type?: string;
  price?: string | number;
  original_size?: string | number;
  size_matched?: string | number;
  asset_id?: string;
  outcome?: string;
  side?: string;
  market?: string;
}

interface ClobUserTradePayload {
  id?: string;
  maker_orders?: Array<{
    order_id?: string;
    matched_amount?: string | number;
    price?: string | number;
  }>;
  taker_order_id?: string;
  price?: string | number;
  size?: string | number;
}

interface ClobUserPositionPayload {
  asset?: string;
  asset_id?: string;
  size?: string | number;
  avg_price?: string | number;
  average_price?: string | number;
  avgPrice?: string | number;
}

let client: RealTimeDataClient | null = null;
let tokenMapTimer: NodeJS.Timeout | null = null;
let metricsTimer: NodeJS.Timeout | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectResetTimer: NodeJS.Timeout | null = null;
let reconnectAttempt = 0;
let lastConnectAttemptAt = 0;
let lastStatus: ConnectionStatus | null = null;
let allowReconnect = true;
let dnsConfigured = false;
let connectInFlight = false;
let connectionEpoch = 0;

let lastMessageAt = 0;
const metrics = {
  orders: 0,
  trades: 0,
  positions: 0,
  basketUpdates: 0,
  mmFills: 0,
};

const orderLocks = new Map<string, Promise<void>>();
const tokenMap = new Map<string, { marketMakerId: string; outcome: "YES" | "NO" }>();

let chainCache: { timestamp: number; map: Map<string, number> | null } | null = null;

const parseNumber = (value: unknown): number | null => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const normalizeStatus = (value?: string): string =>
  typeof value === "string" ? value.toUpperCase() : "";

const shouldUpdateBasketStatus = (current: string, next: string): boolean => {
  if (current === "failed" || current === "simulated") return false;
  const currentRank = BASKET_STATUS_RANK[current] ?? 0;
  const nextRank = BASKET_STATUS_RANK[next] ?? 0;
  return nextRank >= currentRank;
};

const enqueueOrderTask = (orderId: string, task: () => Promise<void>): void => {
  const previous = orderLocks.get(orderId) ?? Promise.resolve();
  const next = previous
    .then(task)
    .catch((error) => {
      console.error("[CLOB WS] Order task error:", error);
    })
    .finally(() => {
      if (orderLocks.get(orderId) === next) {
        orderLocks.delete(orderId);
      }
    });
  orderLocks.set(orderId, next);
};

const refreshTokenMap = async (): Promise<void> => {
  const marketMakers = await prisma.marketMaker.findMany({
    include: { market: { select: { clobTokenIds: true } } },
  });

  tokenMap.clear();

  for (const mm of marketMakers) {
    const tokens = mm.market?.clobTokenIds || [];
    const yesToken = tokens[0];
    const noToken = tokens[1];
    if (yesToken) tokenMap.set(yesToken, { marketMakerId: mm.id, outcome: "YES" });
    if (noToken) tokenMap.set(noToken, { marketMakerId: mm.id, outcome: "NO" });
  }
};

const getChainPositionMap = async (): Promise<Map<string, number> | null> => {
  const now = Date.now();
  const cacheMs = Number(process.env.CLOB_WS_CHAIN_CACHE_MS ?? DEFAULT_CHAIN_CACHE_MS);
  if (chainCache && now - chainCache.timestamp < cacheMs) {
    return chainCache.map;
  }

  const positions = await getPositions(undefined, {
    sizeThreshold: 0,
    limit: 500,
  });

  if (!positions) {
    chainCache = { timestamp: now, map: null };
    return null;
  }

  const map = new Map<string, number>();
  for (const position of positions) {
    map.set(position.asset, position.size);
  }

  chainCache = { timestamp: now, map };
  return map;
};

const logVerificationFailure = async (details: {
  orderId: string;
  outcome: string;
  side: string;
  claimedFillSize: number;
  reason?: string;
  marketSlug?: string | null;
}): Promise<void> => {
  await prisma.log.create({
    data: {
      level: "WARN",
      category: "RECONCILE",
      message: "Fill verification failed - CLOB WS reports fill but chain position mismatch",
      metadata: details,
    },
  });
};

const handleMarketMakerOrderUpdate = async (params: {
  orderId: string;
  sizeMatched: number | null;
  originalSize: number | null;
  price: number | null;
  status: string;
}): Promise<void> => {
  const mmOrder = await prisma.marketMakerOrder.findFirst({
    where: { orderId: params.orderId },
    include: {
      marketMaker: {
        include: { market: true },
      },
    },
  });

  if (!mmOrder) return;

  const updates: Record<string, number> = {};
  if (params.price !== null) {
    const current = Number(mmOrder.price);
    if (Math.abs(current - params.price) > 0.0001) {
      updates.price = params.price;
    }
  }
  if (params.originalSize !== null) {
    const current = Number(mmOrder.size);
    if (Math.abs(current - params.originalSize) > 0.0001) {
      updates.size = params.originalSize;
    }
  }
  if (Object.keys(updates).length > 0) {
    await prisma.marketMakerOrder.updateMany({
      where: { id: mmOrder.id },
      data: updates,
    });
  }

  const previousMatched =
    mmOrder.lastMatchedSize === null || mmOrder.lastMatchedSize === undefined
      ? null
      : Number(mmOrder.lastMatchedSize);

  const sizeMatched = params.sizeMatched;
  const isTerminal = TERMINAL_STATUSES.has(params.status);
  const isLive = LIVE_STATUSES.has(params.status);

  if (sizeMatched !== null) {
    const currentMatched = previousMatched ?? 0;
    if (previousMatched === null) {
      if (sizeMatched > 0) {
        const chainPositionMap = await getChainPositionMap();
        const verification = verifyFillAgainstChain(
          chainPositionMap,
          mmOrder.marketMaker,
          mmOrder,
          sizeMatched
        );
        if (!verification.verified) {
          await logVerificationFailure({
            orderId: mmOrder.orderId,
            outcome: mmOrder.outcome,
            side: mmOrder.side,
            claimedFillSize: sizeMatched,
            reason: verification.reason,
            marketSlug: mmOrder.marketMaker.market?.slug ?? null,
          });
        } else {
          await processFill(
            mmOrder.marketMaker,
            {
              ...mmOrder,
              price: params.price ?? Number(mmOrder.price),
              size: params.originalSize ?? Number(mmOrder.size),
            },
            undefined,
            sizeMatched,
            false,
            true
          );
          metrics.mmFills += 1;
        }
      }

      await prisma.marketMakerOrder.updateMany({
        where: { id: mmOrder.id },
        data: { lastMatchedSize: sizeMatched },
      });
    } else if (sizeMatched > currentMatched) {
      const deltaMatched = sizeMatched - currentMatched;
      const chainPositionMap = await getChainPositionMap();
      const verification = verifyFillAgainstChain(
        chainPositionMap,
        mmOrder.marketMaker,
        mmOrder,
        deltaMatched
      );
      if (!verification.verified) {
        await logVerificationFailure({
          orderId: mmOrder.orderId,
          outcome: mmOrder.outcome,
          side: mmOrder.side,
          claimedFillSize: deltaMatched,
          reason: verification.reason,
          marketSlug: mmOrder.marketMaker.market?.slug ?? null,
        });
      } else {
        await processFill(
          mmOrder.marketMaker,
          {
            ...mmOrder,
            price: params.price ?? Number(mmOrder.price),
            size: params.originalSize ?? Number(mmOrder.size),
          },
          undefined,
          deltaMatched,
          false,
          true
        );
        metrics.mmFills += 1;
        if (isLive) {
          await logQuoteAction(mmOrder.marketMakerId, "PARTIAL_FILL", {
            outcome: mmOrder.outcome,
            side: mmOrder.side,
            orderId: mmOrder.orderId,
            filledSize: deltaMatched,
            totalMatched: sizeMatched,
            originalSize: params.originalSize ?? Number(mmOrder.size),
          });
        }
      }

      await prisma.marketMakerOrder.updateMany({
        where: { id: mmOrder.id },
        data: { lastMatchedSize: sizeMatched },
      });
    }
  }

  if (isTerminal) {
    await prisma.marketMakerOrder.deleteMany({ where: { id: mmOrder.id } });
    await logQuoteAction(mmOrder.marketMakerId, "ORDER_CANCELLED", {
      outcome: mmOrder.outcome,
      side: mmOrder.side,
      orderId: mmOrder.orderId,
      status: params.status,
    });
  }
};

const handleBasketOrderUpdate = async (params: {
  orderId: string;
  sizeMatched: number | null;
  originalSize: number | null;
  price: number | null;
  status: string;
}): Promise<void> => {
  const items = await prisma.basketItem.findMany({
    where: { orderId: params.orderId },
  });
  if (items.length === 0) return;

  const isMatched = params.status === "MATCHED";
  const isCancelled =
    params.status === "CANCELLED" ||
    params.status === "CANCELED" ||
    params.status === "EXPIRED";

  let nextStatus: string | null = null;
  if (isMatched) {
    nextStatus = "filled";
  } else if (isCancelled) {
    nextStatus = "cancelled";
  } else if (
    params.sizeMatched !== null &&
    params.originalSize !== null &&
    params.sizeMatched >= params.originalSize
  ) {
    nextStatus = "filled";
  } else if (params.sizeMatched !== null && params.sizeMatched > 0) {
    nextStatus = "partial";
  }

  for (const item of items) {
    if (!nextStatus || !shouldUpdateBasketStatus(item.status, nextStatus)) {
      continue;
    }

    const data: Record<string, unknown> = {
      status: nextStatus,
    };

    if (params.sizeMatched !== null) {
      data.fillAmount = params.sizeMatched;
    }
    if (params.price !== null) {
      data.fillPrice = params.price;
    }

    await prisma.basketItem.update({
      where: { id: item.id },
      data,
    });

    metrics.basketUpdates += 1;
  }
};

const handlePositionUpdate = async (payload: ClobUserPositionPayload): Promise<void> => {
  const asset = payload.asset ?? payload.asset_id;
  if (!asset) return;

  const size = parseNumber(payload.size);
  if (size === null) return;

  const avgPrice =
    parseNumber(payload.avgPrice) ??
    parseNumber(payload.avg_price) ??
    parseNumber(payload.average_price);

  const mapping = tokenMap.get(asset);
  if (!mapping) return;

  const data: Record<string, number> =
    mapping.outcome === "YES"
      ? { yesInventory: size }
      : { noInventory: size };

  if (avgPrice !== null) {
    if (mapping.outcome === "YES") {
      data.avgYesCost = avgPrice;
    } else {
      data.avgNoCost = avgPrice;
    }
  }

  await prisma.marketMaker.update({
    where: { id: mapping.marketMakerId },
    data,
  });

  metrics.positions += 1;
};

const handleOrderMessage = async (payload: ClobUserOrderPayload): Promise<void> => {
  if (!payload.id) return;

  const sizeMatched = parseNumber(payload.size_matched);
  const originalSize = parseNumber(payload.original_size);
  const price = parseNumber(payload.price);
  const status = normalizeStatus(payload.status);

  enqueueOrderTask(payload.id, async () => {
    await handleMarketMakerOrderUpdate({
      orderId: payload.id as string,
      sizeMatched,
      originalSize,
      price,
      status,
    });

    await handleBasketOrderUpdate({
      orderId: payload.id as string,
      sizeMatched,
      originalSize,
      price,
      status,
    });
  });
};

const handleTradeMessage = async (payload: ClobUserTradePayload): Promise<void> => {
  if (!payload.maker_orders || payload.maker_orders.length === 0) return;

  for (const makerOrder of payload.maker_orders) {
    const orderId = makerOrder.order_id;
    if (!orderId) continue;
    const matched = parseNumber(makerOrder.matched_amount);
    if (matched === null || matched <= 0) continue;

    enqueueOrderTask(orderId, async () => {
      const order = await prisma.marketMakerOrder.findFirst({
        where: { orderId },
      });
      const basket = await prisma.basketItem.findFirst({
        where: { orderId },
      });

      if (!order && !basket) return;

      const currentMatched = order
        ? order.lastMatchedSize === null || order.lastMatchedSize === undefined
          ? 0
          : Number(order.lastMatchedSize)
        : 0;

      await handleMarketMakerOrderUpdate({
        orderId,
        sizeMatched: currentMatched + matched,
        originalSize: order ? Number(order.size) : null,
        price: parseNumber(makerOrder.price) ?? parseNumber(payload.price),
        status: "",
      });

      if (basket) {
        await handleBasketOrderUpdate({
          orderId,
          sizeMatched: (basket.fillAmount ? Number(basket.fillAmount) : 0) + matched,
          originalSize: null,
          price: parseNumber(makerOrder.price) ?? parseNumber(payload.price),
          status: "",
        });
      }
    });
  }
};

const handleMessage = async (message: Message): Promise<void> => {
  if (message.topic !== "clob_user") return;

  lastMessageAt = Date.now();

  if (message.type === "order") {
    metrics.orders += 1;
    await handleOrderMessage(message.payload as ClobUserOrderPayload);
    return;
  }

  if (message.type === "trade") {
    metrics.trades += 1;
    await handleTradeMessage(message.payload as ClobUserTradePayload);
    return;
  }

  if (message.type === "position" || message.type === "position_update") {
    await handlePositionUpdate(message.payload as ClobUserPositionPayload);
  }
};

const ensureIpv4First = (): void => {
  if (dnsConfigured) return;
  dnsConfigured = true;
  try {
    dns.setDefaultResultOrder("ipv4first");
  } catch (error) {
    console.warn("[CLOB WS] Failed to set DNS ipv4first:", error);
  }
};

const getReconnectDelay = (): number => {
  const baseMs = Number(
    process.env.CLOB_WS_RECONNECT_BASE_MS ?? DEFAULT_RECONNECT_BASE_MS
  );
  const maxMs = Number(
    process.env.CLOB_WS_RECONNECT_MAX_MS ?? DEFAULT_RECONNECT_MAX_MS
  );
  const jitterMs = Number(
    process.env.CLOB_WS_RECONNECT_JITTER_MS ?? DEFAULT_RECONNECT_JITTER_MS
  );
  const expDelay = baseMs * Math.pow(2, reconnectAttempt);
  const capped = Math.min(expDelay, maxMs);
  const jitter = Math.floor(Math.random() * Math.max(jitterMs, 0));
  return capped + jitter;
};

const clearReconnectTimer = (): void => {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
};

const clearReconnectResetTimer = (): void => {
  if (reconnectResetTimer) {
    clearTimeout(reconnectResetTimer);
    reconnectResetTimer = null;
  }
};

const resetReconnect = (): void => {
  reconnectAttempt = 0;
  clearReconnectTimer();
};

const markConnected = (): void => {
  connectInFlight = false;
  connectionEpoch += 1;
};

const scheduleReconnectReset = (): void => {
  clearReconnectResetTimer();
  const resetMs = Number(
    process.env.CLOB_WS_RECONNECT_RESET_MS ?? DEFAULT_RECONNECT_RESET_MS
  );
  reconnectResetTimer = setTimeout(() => {
    resetReconnect();
  }, resetMs);
};

const scheduleReconnect = (reason: string): void => {
  if (!client || !allowReconnect) return;
  if (reconnectTimer) return;
  if (connectInFlight) return;
  if (
    lastStatus === ConnectionStatus.CONNECTED ||
    lastStatus === ConnectionStatus.CONNECTING
  ) {
    return;
  }

  const delay = getReconnectDelay();
  const attempt = reconnectAttempt + 1;
  const scheduledEpoch = connectionEpoch;
  console.warn(`[CLOB WS] Reconnecting in ${delay}ms (attempt ${attempt}) after ${reason}`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (connectionEpoch !== scheduledEpoch) {
      return;
    }
    reconnectAttempt = attempt;
    connectClient(`retry-${attempt}`);
  }, delay);
};

const connectClient = (reason: string): void => {
  if (!client || !allowReconnect) return;
  if (connectInFlight) return;
  if (lastStatus === ConnectionStatus.CONNECTED || lastStatus === ConnectionStatus.CONNECTING) {
    return;
  }

  const minGapMs = Number(
    process.env.CLOB_WS_RECONNECT_MIN_GAP_MS ?? DEFAULT_RECONNECT_MIN_GAP_MS
  );
  const now = Date.now();
  if (now - lastConnectAttemptAt < minGapMs) {
    scheduleReconnect("connect-throttle");
    return;
  }

  lastConnectAttemptAt = now;
  connectInFlight = true;
  lastStatus = ConnectionStatus.CONNECTING;
  console.log(`[CLOB WS] Connecting (${reason})`);
  client.connect();
};

const startMetrics = (): void => {
  const intervalMs = Number(
    process.env.CLOB_WS_METRICS_INTERVAL_MS ?? DEFAULT_METRICS_INTERVAL_MS
  );
  metricsTimer = setInterval(() => {
    if (!lastMessageAt) return;
    console.log(
      `[CLOB WS] ${metrics.orders} orders, ${metrics.trades} trades, ` +
      `${metrics.mmFills} fills, ${metrics.basketUpdates} basket updates ` +
      `(last message ${new Date(lastMessageAt).toISOString()})`
    );
    metrics.orders = 0;
    metrics.trades = 0;
    metrics.mmFills = 0;
    metrics.basketUpdates = 0;
  }, intervalMs);
};

export const startClobUserWs = (): RealTimeDataClient | null => {
  if (client) return client;

  const creds = getClobCredentials();
  if (!creds) {
    console.warn("[CLOB WS] Missing CLOB credentials, WS listener disabled.");
    return null;
  }
  ensureIpv4First();

  const rawHost =
    process.env.CLOB_WS_HOST ??
    process.env.POLYMARKET_WS_HOST ??
    DEFAULT_WS_HOST;
  const host = rawHost.startsWith("wss://") ? rawHost : DEFAULT_WS_HOST;
  if (host !== rawHost) {
    console.warn(`[CLOB WS] Invalid WS host ${rawHost}; falling back to ${DEFAULT_WS_HOST}`);
  }

  const pingInterval = Number(
    process.env.CLOB_WS_PING_INTERVAL_MS ?? DEFAULT_PING_INTERVAL_MS
  );

  client = new RealTimeDataClient({
    host,
    pingInterval,
    onConnect: (activeClient) => {
      console.log(`[CLOB WS] Connected to ${host}`);
      lastMessageAt = Date.now();
      activeClient.subscribe({
        subscriptions: [
          {
            topic: "clob_user",
            type: "*",
            clob_auth: {
              key: creds.apiKey,
              secret: creds.apiSecret,
              passphrase: creds.passphrase,
            },
          },
        ],
      });
    },
    onMessage: async (_client, message) => {
      await handleMessage(message);
    },
    onStatusChange: (status) => {
      lastStatus = status;
      if (status === ConnectionStatus.DISCONNECTED) {
        console.warn("[CLOB WS] Disconnected");
        connectInFlight = false;
        clearReconnectResetTimer();
        scheduleReconnect("disconnect");
        return;
      }
      if (status === ConnectionStatus.CONNECTED) {
        clearReconnectTimer();
        markConnected();
        scheduleReconnectReset();
      }
      console.log(`[CLOB WS] Status: ${status}`);
    },
  });

  const clientInternal = client as unknown as {
    autoReconnect: boolean;
    onError: (err: unknown) => void;
  };
  // Work around upstream autoReconnect always-on behavior so we can control backoff.
  clientInternal.autoReconnect = false;
  const originalOnError = clientInternal.onError.bind(clientInternal);
  clientInternal.onError = (err: unknown) => {
    originalOnError(err);
    scheduleReconnect("error");
  };

  allowReconnect = true;
  connectClient("startup");

  refreshTokenMap().catch((error) => {
    console.error("[CLOB WS] Failed to load token map:", error);
  });

  const refreshMs = Number(
    process.env.CLOB_WS_TOKEN_REFRESH_MS ?? DEFAULT_TOKEN_REFRESH_MS
  );
  tokenMapTimer = setInterval(() => {
    refreshTokenMap().catch((error) => {
      console.error("[CLOB WS] Failed to refresh token map:", error);
    });
  }, refreshMs);

  startMetrics();

  return client;
};

export const stopClobUserWs = (): void => {
  if (metricsTimer) {
    clearInterval(metricsTimer);
    metricsTimer = null;
  }
  if (tokenMapTimer) {
    clearInterval(tokenMapTimer);
    tokenMapTimer = null;
  }
  allowReconnect = false;
  clearReconnectTimer();
  clearReconnectResetTimer();
  lastStatus = null;
  connectInFlight = false;
  connectionEpoch = 0;
  if (client) {
    client.disconnect();
    client = null;
  }
};
