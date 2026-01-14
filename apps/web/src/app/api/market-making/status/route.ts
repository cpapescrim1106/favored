import { prisma } from "@/lib/db";
import { NextResponse } from "next/server";
import { configureCLOB, fetchActiveOrders, getBalance, getPositions } from "@favored/shared";

const STATUS_STALE_MS = Number(process.env.MM_STATUS_STALE_MS ?? 120000);

type CheckResult<T> = {
  ok: boolean;
  durationMs: number;
  value?: T;
  error?: string;
};

async function timedCheck<T>(
  fn: () => Promise<T | null>
): Promise<CheckResult<T>> {
  const start = Date.now();
  try {
    const value = await fn();
    const durationMs = Date.now() - start;
    if (value === null) {
      return { ok: false, durationMs, error: "null_response" };
    }
    return { ok: true, durationMs, value };
  } catch (error) {
    return {
      ok: false,
      durationMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * GET /api/market-making/status
 * Returns dependency health and MM activity status.
 */
export async function GET() {
  try {
    configureCLOB({ dryRun: false });

    const [
      config,
      activeCount,
      pausedCount,
      trackedOrdersCount,
      lastQuoteAgg,
      balanceCheck,
      openOrdersCheck,
      positionsCheck,
    ] = await Promise.all([
      prisma.config.findUnique({ where: { id: "singleton" } }),
      prisma.marketMaker.count({ where: { active: true } }),
      prisma.marketMaker.count({ where: { active: true, paused: true } }),
      prisma.marketMakerOrder.count(),
      prisma.marketMaker.aggregate({
        where: { active: true },
        _max: { lastQuoteAt: true },
      }),
      timedCheck(() => getBalance()),
      timedCheck(() => fetchActiveOrders()),
      timedCheck(() => getPositions(undefined, { sizeThreshold: 0, limit: 500 })),
    ]);

    const now = Date.now();
    const lastQuoteAt = lastQuoteAgg._max.lastQuoteAt ?? null;
    const lastQuoteAgeMs = lastQuoteAt ? now - lastQuoteAt.getTime() : null;
    const stale = lastQuoteAgeMs !== null && lastQuoteAgeMs > STATUS_STALE_MS;

    const openOrdersCount =
      openOrdersCheck.ok && Array.isArray(openOrdersCheck.value)
        ? openOrdersCheck.value.length
        : null;
    const positionsCount =
      positionsCheck.ok && Array.isArray(positionsCheck.value)
        ? positionsCheck.value.length
        : null;

    const openOrdersEmptyWithTracked =
      openOrdersCheck.ok && openOrdersCount === 0 && trackedOrdersCount > 0;

    const dependencyDegraded =
      !balanceCheck.ok ||
      !openOrdersCheck.ok ||
      !positionsCheck.ok ||
      openOrdersEmptyWithTracked;

    return NextResponse.json({
      now: new Date(now).toISOString(),
      dependencyHealth: {
        degraded: dependencyDegraded,
        balance: {
          ok: balanceCheck.ok,
          durationMs: balanceCheck.durationMs,
          balance: balanceCheck.ok ? balanceCheck.value?.balance ?? null : null,
          allowance: balanceCheck.ok ? balanceCheck.value?.allowance ?? null : null,
          error: balanceCheck.error,
        },
        openOrders: {
          ok: openOrdersCheck.ok,
          durationMs: openOrdersCheck.durationMs,
          count: openOrdersCount,
          warning: openOrdersEmptyWithTracked ? "empty_with_tracked_orders" : null,
          error: openOrdersCheck.error,
        },
        positions: {
          ok: positionsCheck.ok,
          durationMs: positionsCheck.durationMs,
          count: positionsCount,
          error: positionsCheck.error,
        },
      },
      marketMaking: {
        enabled: config?.mmEnabled ?? false,
        killSwitchActive: config?.killSwitchActive ?? false,
        activeCount,
        pausedCount,
        trackedOrdersCount,
        lastQuoteAt: lastQuoteAt ? lastQuoteAt.toISOString() : null,
        lastQuoteAgeMs,
        stale,
      },
    });
  } catch (error) {
    console.error("MM status check failed:", error);
    return NextResponse.json(
      { error: "Failed to fetch market-making status" },
      { status: 500 }
    );
  }
}
