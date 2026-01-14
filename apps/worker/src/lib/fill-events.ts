import { prisma } from "./db.js";

const PENDING_FILL_TTL_MS = Number(
  process.env.MM_PENDING_FILL_TTL_MS ?? 15 * 60 * 1000
);
const PENDING_FILL_TOLERANCE = Number(
  process.env.MM_PENDING_FILL_TOLERANCE ?? 0.1
);

type FillSide = "BUY" | "SELL";
type FillOutcome = "YES" | "NO";

export type PendingFillInput = {
  marketMakerId: string;
  orderId: string;
  outcome: FillOutcome;
  side: FillSide;
  price: number;
  size: number;
  matchedTotal: number;
  source?: string;
  metadata?: Record<string, unknown>;
  observedAt?: Date;
};

export async function recordPendingFillEvent(
  input: PendingFillInput
): Promise<boolean> {
  const size = Number(input.size);
  const price = Number(input.price);
  const matchedTotal = Number(input.matchedTotal);
  if (!Number.isFinite(size) || size <= 0) return false;
  if (!Number.isFinite(price) || price <= 0) return false;
  if (!Number.isFinite(matchedTotal) || matchedTotal <= 0) return false;

  const existing = await prisma.marketMakerFillEvent.findUnique({
    where: {
      orderId_matchedTotal: {
        orderId: input.orderId,
        matchedTotal,
      },
    },
    select: { id: true },
  });
  if (existing) return false;

  await prisma.marketMakerFillEvent.create({
    data: {
      marketMakerId: input.marketMakerId,
      outcome: input.outcome,
      side: input.side,
      orderId: input.orderId,
      price,
      size,
      value: price * size,
      matchedTotal,
      source: input.source ?? null,
      metadata: input.metadata ?? undefined,
      observedAt: input.observedAt ?? new Date(),
    },
  });

  return true;
}

export async function confirmPendingFillsForMarketMaker(params: {
  mm: {
    id: string;
    avgYesCost: unknown;
    avgNoCost: unknown;
    realizedPnl: unknown;
  };
  driftByOutcome: { YES: number; NO: number };
  now?: Date;
}): Promise<{ confirmed: number; partial: number; rejected: number }> {
  const now = params.now ?? new Date();
  const cutoff = new Date(now.getTime() - PENDING_FILL_TTL_MS);

  const pending = await prisma.marketMakerFillEvent.findMany({
    where: { marketMakerId: params.mm.id, status: "PENDING" },
    orderBy: { observedAt: "asc" },
  });

  if (pending.length === 0) {
    return { confirmed: 0, partial: 0, rejected: 0 };
  }

  let realizedPnl = Number(params.mm.realizedPnl);
  let confirmed = 0;
  let partial = 0;
  let rejected = 0;

  const processOutcome = async (outcome: FillOutcome, drift: number) => {
    const direction: FillSide | null =
      drift > PENDING_FILL_TOLERANCE
        ? "BUY"
        : drift < -PENDING_FILL_TOLERANCE
          ? "SELL"
          : null;

    if (!direction) return;

    let remaining = Math.abs(drift);
    const avgCost =
      outcome === "YES"
        ? Number(params.mm.avgYesCost)
        : Number(params.mm.avgNoCost);

    for (const event of pending) {
      if (remaining <= PENDING_FILL_TOLERANCE) break;
      if (event.outcome !== outcome || event.side !== direction) continue;

      const size = Number(event.size);
      if (!Number.isFinite(size) || size <= 0) continue;

      const confirmSize = Math.min(size, remaining);
      if (confirmSize <= PENDING_FILL_TOLERANCE) break;

      const price = Number(event.price);
      const value = price * confirmSize;

      let fillRealizedPnl: number | null = null;
      if (direction === "SELL" && avgCost > 0) {
        fillRealizedPnl = (price - avgCost) * confirmSize;
        realizedPnl += fillRealizedPnl;
      }

      const fullConfirm = confirmSize >= size - PENDING_FILL_TOLERANCE;

      const updated = await prisma.marketMakerFillEvent.updateMany({
        where: { id: event.id, status: "PENDING" },
        data: fullConfirm
          ? { status: "CONFIRMED", confirmedAt: now }
          : {
              size: size - confirmSize,
              value: price * (size - confirmSize),
              metadata: {
                ...(event.metadata && typeof event.metadata === "object"
                  ? event.metadata
                  : {}),
                originalSize: size,
                confirmedSize: confirmSize,
              },
            },
      });

      if (updated.count === 0) {
        continue;
      }

      await prisma.marketMakerFill.create({
        data: {
          marketMakerId: event.marketMakerId,
          outcome: event.outcome,
          side: event.side,
          orderId: event.orderId,
          price,
          size: confirmSize,
          value,
          realizedPnl: fillRealizedPnl,
          filledAt: event.observedAt,
        },
      });

      if (fullConfirm) {
        confirmed += 1;
      } else {
        partial += 1;
      }

      remaining -= confirmSize;
    }
  };

  await processOutcome("YES", params.driftByOutcome.YES);
  await processOutcome("NO", params.driftByOutcome.NO);

  if (realizedPnl !== Number(params.mm.realizedPnl)) {
    await prisma.marketMaker.update({
      where: { id: params.mm.id },
      data: { realizedPnl },
    });
  }

  for (const event of pending) {
    if (event.observedAt >= cutoff) continue;
    const updated = await prisma.marketMakerFillEvent.updateMany({
      where: { id: event.id, status: "PENDING" },
      data: {
        status: "REJECTED",
        metadata: {
          ...(event.metadata && typeof event.metadata === "object"
            ? event.metadata
            : {}),
          rejectedReason: "ttl_expired",
        },
      },
    });
    if (updated.count > 0) {
      rejected += 1;
    }
  }

  return { confirmed, partial, rejected };
}
