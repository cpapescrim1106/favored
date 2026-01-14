import axios, { type AxiosInstance } from "axios";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { createLimiter } from "../venues/rate-limit.js";
import type { KalshiBalanceResponse } from "./types.js";

export interface KalshiClientConfig {
  baseUrl: string;
  wsUrl: string;
  keyId?: string;
  privateKeyPem?: string;
}

const PROD_BASE_URL = "https://api.elections.kalshi.com/trade-api/v2";
const PROD_WS_URL = "wss://api.elections.kalshi.com/trade-api/ws/v2";
const DEMO_BASE_URL = "https://demo-api.kalshi.co/trade-api/v2";
const DEMO_WS_URL = "wss://demo-api.kalshi.co/trade-api/ws/v2";

function resolveKalshiEnv(): "demo" | "prod" {
  const raw = (process.env.KALSHI_ENV || "").toLowerCase();
  if (raw === "prod" || raw === "production" || raw === "live") return "prod";
  if (raw === "demo" || raw === "dev" || raw === "test") return "demo";
  return process.env.NODE_ENV === "production" ? "prod" : "demo";
}

function resolveDefaultBaseUrl(): string {
  return resolveKalshiEnv() === "prod" ? PROD_BASE_URL : DEMO_BASE_URL;
}

function resolveDefaultWsUrl(): string {
  return resolveKalshiEnv() === "prod" ? PROD_WS_URL : DEMO_WS_URL;
}

const publicLimiter = createLimiter(Number(process.env.KALSHI_PUBLIC_MIN_INTERVAL_MS ?? 120));
const privateLimiter = createLimiter(Number(process.env.KALSHI_PRIVATE_MIN_INTERVAL_MS ?? 300));

let cachedConfig: KalshiClientConfig | null = null;

function loadPrivateKeyFromEnv(): string | undefined {
  const keyPath = process.env.KALSHI_PRIVATE_KEY_PATH;
  if (keyPath) {
    const resolved = path.resolve(keyPath);
    return fs.readFileSync(resolved, "utf8");
  }
  const raw = process.env.KALSHI_PRIVATE_KEY;
  if (!raw) return undefined;
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

export function getKalshiConfig(): KalshiClientConfig {
  if (cachedConfig) return cachedConfig;

  cachedConfig = {
    baseUrl: process.env.KALSHI_BASE_URL || resolveDefaultBaseUrl(),
    wsUrl: process.env.KALSHI_WS_URL || resolveDefaultWsUrl(),
    keyId: process.env.KALSHI_KEY_ID,
    privateKeyPem: loadPrivateKeyFromEnv(),
  };

  return cachedConfig;
}

export function resetKalshiConfig(): void {
  cachedConfig = null;
}

export function isKalshiConfigured(): boolean {
  const config = getKalshiConfig();
  return Boolean(config.keyId && config.privateKeyPem);
}

export function getKalshiSubaccount(): number | undefined {
  const raw = process.env.KALSHI_SUBACCOUNT;
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function signMessage(privateKeyPem: string, message: string): string {
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(message);
  sign.end();
  const signature = sign.sign({
    key: privateKeyPem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return signature.toString("base64");
}

export function createAuthHeaders(method: string, pathWithQuery: string): Record<string, string> {
  const config = getKalshiConfig();
  if (!config.keyId || !config.privateKeyPem) {
    throw new Error(
      "Missing Kalshi credentials (KALSHI_KEY_ID, KALSHI_PRIVATE_KEY or KALSHI_PRIVATE_KEY_PATH)"
    );
  }

  const timestamp = Date.now().toString();
  const pathOnly = pathWithQuery.split("?")[0];
  const basePath = new URL(config.baseUrl).pathname.replace(/\/$/, "");
  const normalizedPath = pathOnly.startsWith("/") ? pathOnly : `/${pathOnly}`;
  const signedPath =
    basePath && basePath !== "/" && !normalizedPath.startsWith(basePath)
      ? `${basePath}${normalizedPath}`
      : normalizedPath;
  const message = `${timestamp}${method.toUpperCase()}${signedPath}`;
  const signature = signMessage(config.privateKeyPem, message);

  return {
    "KALSHI-ACCESS-KEY": config.keyId,
    "KALSHI-ACCESS-SIGNATURE": signature,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
  };
}

let clientInstance: AxiosInstance | null = null;

function getHttpClient(): AxiosInstance {
  if (clientInstance) return clientInstance;
  const config = getKalshiConfig();
  clientInstance = axios.create({
    baseURL: config.baseUrl,
    timeout: Number(process.env.KALSHI_HTTP_TIMEOUT_MS ?? 15000),
  });
  return clientInstance;
}

export async function kalshiRequest<T>(params: {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  data?: unknown;
  auth?: boolean;
}): Promise<T> {
  const { method, path: requestPath, query, data, auth } = params;
  const client = getHttpClient();

  const queryString = query
    ? `?${new URLSearchParams(
        Object.entries(query)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, String(value)])
      ).toString()}`
    : "";

  const fullPath = `${requestPath}${queryString}`;
  const headers: Record<string, string> = {};

  if (auth) {
    Object.assign(headers, createAuthHeaders(method, fullPath));
  }

  const limiter = auth ? privateLimiter : publicLimiter;

  return limiter.schedule(async () => {
    const response = await client.request<T>({
      method,
      url: fullPath,
      data,
      headers,
    });
    return response.data;
  });
}

export function parseFixedPoint(value?: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function getKalshiBalance(): Promise<{
  balance: number;
  portfolioValue: number;
  updatedTs: number;
} | null> {
  if (!isKalshiConfigured()) return null;

  const response = await kalshiRequest<KalshiBalanceResponse>({
    method: "GET",
    path: "/portfolio/balance",
    auth: true,
  });

  return {
    balance: response.balance / 100,
    portfolioValue: response.portfolio_value / 100,
    updatedTs: response.updated_ts,
  };
}
