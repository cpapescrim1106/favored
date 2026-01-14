import { createAuthHeaders, getKalshiConfig } from "./client.js";
import { normalizeKalshiOrderbook } from "./normalize.js";
import type { KalshiOrderbook } from "./types.js";
import type { VenueOrderbook } from "../venues/types.js";

export interface KalshiOrderbookSubscription {
  marketTickers: string[];
  onSnapshot: (orderbook: VenueOrderbook) => void;
  onDelta: (orderbook: VenueOrderbook) => void;
  onError: (error: Error) => void;
}

type OrderbookState = {
  yes: Map<number, number>;
  no: Map<number, number>;
};

const buildOrderbookFromState = (ticker: string, state: OrderbookState): VenueOrderbook => {
  const yesLevels = Array.from(state.yes.entries()).map(([price, size]) => [price, size]);
  const noLevels = Array.from(state.no.entries()).map(([price, size]) => [price, size]);
  return normalizeKalshiOrderbook({
    ticker,
    orderbook: {
      yes: yesLevels as KalshiOrderbook["yes"],
      no: noLevels as KalshiOrderbook["no"],
    },
  });
};

const applyDelta = (state: OrderbookState, updates: Array<[number, number]>, side: "yes" | "no") => {
  const map = side === "yes" ? state.yes : state.no;
  for (const [price, size] of updates) {
    if (size <= 0) {
      map.delete(price);
    } else {
      map.set(price, size);
    }
  }
};

export async function subscribeKalshiOrderbook(
  params: KalshiOrderbookSubscription
): Promise<() => void> {
  if (typeof WebSocket === "undefined") {
    throw new Error("WebSocket is not available in this runtime");
  }

  const config = getKalshiConfig();
  let headers: Record<string, string> | undefined;
  try {
    headers = createAuthHeaders("GET", "/trade-api/ws/v2");
  } catch {
    headers = undefined;
  }

  const stateByTicker = new Map<string, OrderbookState>();

  type WebSocketWithHeaders = new (
    url: string,
    protocols?: string | string[] | { headers?: Record<string, string> }
  ) => WebSocket;
  const WsCtor = WebSocket as unknown as WebSocketWithHeaders;
  const socket = new WsCtor(
    config.wsUrl,
    headers ? { headers } : undefined
  );

  let open = false;

  const subscribe = () => {
    const payload = {
      id: Date.now(),
      cmd: "subscribe",
      params: {
        channels: ["orderbook_delta"],
        market_tickers: params.marketTickers,
      },
    };
    socket.send(JSON.stringify(payload));
  };

  socket.addEventListener("open", () => {
    open = true;
    subscribe();
  });

  socket.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(String(event.data));
      const type = data.type as string;
      const payload = data.data ?? data.msg ?? data;
      const ticker = payload.market_ticker || payload.ticker;
      if (!ticker) return;

      if (type === "orderbook_snapshot") {
        const book = payload.orderbook ?? payload;
        const yesLevels = book.yes ?? [];
        const noLevels = book.no ?? [];

        const state: OrderbookState = {
          yes: new Map(yesLevels.map(([price, size]: [number, number]) => [price, size])),
          no: new Map(noLevels.map(([price, size]: [number, number]) => [price, size])),
        };
        stateByTicker.set(ticker, state);
        params.onSnapshot(buildOrderbookFromState(ticker, state));
        return;
      }

      if (type === "orderbook_update" || type === "orderbook_delta") {
        const state = stateByTicker.get(ticker);
        if (!state) return;

        const updates = payload.delta ?? payload;
        if (updates.yes) {
          applyDelta(state, updates.yes as Array<[number, number]>, "yes");
        }
        if (updates.no) {
          applyDelta(state, updates.no as Array<[number, number]>, "no");
        }

        params.onDelta(buildOrderbookFromState(ticker, state));
      }

      if (type === "error") {
        const message = payload?.msg || payload?.message || "Kalshi WS error";
        params.onError(new Error(message));
      }
    } catch (error) {
      params.onError(error instanceof Error ? error : new Error(String(error)));
    }
  });

  socket.addEventListener("close", () => {
    if (open) {
      params.onError(new Error("Kalshi WS closed"));
    }
  });

  socket.addEventListener("error", () => {
    params.onError(new Error("Kalshi WS error"));
  });

  return () => {
    socket.close();
  };
}
