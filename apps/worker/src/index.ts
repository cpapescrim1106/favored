import cron from "node-cron";
import { runScanJob } from "./jobs/scan.js";
import { runReconcileJob } from "./jobs/reconcile.js";
import { runExitCheckJob } from "./jobs/exit-check.js";
import { runMarketMakingJob } from "./jobs/market-making.js";
import { runKalshiMarketMakingJob } from "./jobs/market-making-kalshi.js";
import { runMmCandidatesJob } from "./jobs/mm-candidates.js";
import { fullSync, quickSync, syncInventoryFromChain } from "./jobs/data-integrity.js";
import { prisma } from "./lib/db.js";
import { withAdvisoryLock } from "./lib/lock.js";
import { startClobUserWs, stopClobUserWs } from "./ws/clob-user.js";

const SCAN_INTERVAL = process.env.SCAN_INTERVAL || "*/10 * * * *"; // Every 10 minutes
const MM_INTERVAL = process.env.MM_INTERVAL || "*/5 * * * * *"; // Every 5 seconds
const SYNC_INTERVAL = process.env.SYNC_INTERVAL || "0 * * * *"; // Every hour (sync is now alert-only)
const INVENTORY_SYNC_INTERVAL = process.env.INVENTORY_SYNC_INTERVAL || "*/10 * * * * *"; // Every 10 seconds
const MM_CANDIDATES_INTERVAL =
  process.env.MM_CANDIDATES_INTERVAL || "0 4 * * *"; // Daily at 4am
const MM_CANDIDATES_ENABLED = process.env.MM_CANDIDATES_ENABLED !== "false";
const MM_CANDIDATES_RUN_ON_STARTUP =
  process.env.MM_CANDIDATES_RUN_ON_STARTUP !== "false";

let globalJobRunning = false;
let globalJobLabel: string | null = null;
async function runWithGlobalLock(
  label: string,
  fn: () => Promise<void>
): Promise<boolean> {
  if (globalJobRunning) {
    console.log(
      `[Worker] ${label} skipped - ${globalJobLabel ?? "another job"} running`
    );
    return false;
  }

  globalJobRunning = true;
  globalJobLabel = label;
  try {
    const lockLabel = `worker:${label}`;
    const { acquired } = await withAdvisoryLock(lockLabel, fn);
    if (!acquired) {
      console.log(`[Worker] ${label} skipped - lock unavailable`);
    }
    return acquired;
  } finally {
    globalJobRunning = false;
    globalJobLabel = null;
  }
}

async function main() {
  console.log("[Worker] Starting Favored worker service...");
  console.log(`[Worker] Scan interval: ${SCAN_INTERVAL}`);
  console.log(`[Worker] Market Making interval: ${MM_INTERVAL}`);
  console.log(`[Worker] Data Sync interval: ${SYNC_INTERVAL}`);
  console.log(`[Worker] Inventory Sync interval: ${INVENTORY_SYNC_INTERVAL}`);
  if (MM_CANDIDATES_ENABLED) {
    console.log(`[Worker] MM Candidates interval: ${MM_CANDIDATES_INTERVAL}`);
  } else {
    console.log("[Worker] MM Candidates job disabled");
  }
  if (process.env.CLOB_WS_ENABLED === "true") {
    console.log("[Worker] CLOB WS listener enabled");
    startClobUserWs();
  }

  // Run initial data integrity sync on startup (corrects any drift)
  console.log("[Worker] Running initial data integrity sync...");
  try {
    const syncResult = await fullSync(true, true);
    console.log(`[Worker] Initial sync: ${syncResult.issues.length} issues found, ${syncResult.positionsCorrected} positions corrected`);
  } catch (e) {
    console.error("[Worker] Initial sync failed:", e);
  }

  // Run initial scan on startup
  console.log("[Worker] Running initial scan...");
  await runAllJobs();

  if (MM_CANDIDATES_ENABLED && MM_CANDIDATES_RUN_ON_STARTUP) {
    console.log("[Worker] Running initial MM candidates refresh...");
    await runMmCandidatesJobWrapper();
  }

  // Schedule recurring scanner jobs (every 10 minutes)
  cron.schedule(SCAN_INTERVAL, async () => {
    console.log(`[Worker] Scan cron triggered at ${new Date().toISOString()}`);
    await runAllJobs();
  });

  // Schedule market making job (every 30 seconds)
  cron.schedule(MM_INTERVAL, async () => {
    await runMarketMakingJobWrapper();
  });

  // Schedule independent inventory sync (every 30 seconds, offset from MM job)
  // This catches drift faster than waiting for the full sync
  cron.schedule(INVENTORY_SYNC_INTERVAL, async () => {
    await runInventorySyncWrapper();
  });

  // Schedule data integrity sync (every 5 minutes)
  cron.schedule(SYNC_INTERVAL, async () => {
    await runDataIntegritySyncWrapper();
  });

  if (MM_CANDIDATES_ENABLED) {
    cron.schedule(MM_CANDIDATES_INTERVAL, async () => {
      console.log(
        `[Worker] MM candidates cron triggered at ${new Date().toISOString()}`
      );
      await runMmCandidatesJobWrapper();
    });
  }

  console.log("[Worker] Worker service started. Waiting for scheduled jobs...");
}

// Wrapper to prevent overlapping MM jobs
let mmJobRunning = false;
async function runMarketMakingJobWrapper() {
  if (mmJobRunning) {
    return; // Skip if previous job is still running
  }

  mmJobRunning = true;
  try {
    await runWithGlobalLock("market-making", async () => {
      // Run MM job (includes fill checking)
      await runMarketMakingJob();
      if (process.env.KALSHI_MM_ENABLED === "true") {
        await runKalshiMarketMakingJob();
      }
    });
  } catch (error) {
    console.error("[Worker] Market making job error:", error);
  } finally {
    mmJobRunning = false;
  }
}

// Wrapper to prevent overlapping inventory sync jobs
let inventorySyncRunning = false;
async function runInventorySyncWrapper() {
  if (inventorySyncRunning) {
    return; // Skip if previous sync is still running
  }

  inventorySyncRunning = true;
  try {
    await runWithGlobalLock("inventory-sync", async () => {
      const result = await syncInventoryFromChain();
      if (result.corrected > 0) {
        console.log(
          `[Worker] Inventory sync corrected ${result.corrected} positions`
        );
      }
    });
  } catch (error) {
    console.error("[Worker] Inventory sync error:", error);
  } finally {
    inventorySyncRunning = false;
  }
}

// Wrapper to prevent overlapping sync jobs
let syncJobRunning = false;
async function runDataIntegritySyncWrapper() {
  if (syncJobRunning) {
    return; // Skip if previous sync is still running
  }

  syncJobRunning = true;
  try {
    await runWithGlobalLock("data-integrity", async () => {
      // First do a quick check
      const quickResult = await quickSync();

      if (!quickResult.ordersMatch || !quickResult.positionsMatch) {
        // Drift detected - run full sync with auto-correction
        console.log("[Worker] Drift detected, running full sync...");
        const syncResult = await fullSync(true, false);

        if (syncResult.issues.length > 0) {
          console.log(
            `[Worker] Sync corrected ${syncResult.positionsCorrected} positions, removed ${syncResult.ordersRemoved} stale orders`
          );
        }
      }
    });
  } catch (error) {
    console.error("[Worker] Data integrity sync error:", error);
  } finally {
    syncJobRunning = false;
  }
}

let mmCandidatesRunning = false;
async function runMmCandidatesJobWrapper() {
  if (mmCandidatesRunning) {
    return;
  }

  mmCandidatesRunning = true;
  try {
    await runMmCandidatesJob();
  } catch (error) {
    console.error("[Worker] MM candidates job error:", error);
  } finally {
    mmCandidatesRunning = false;
  }
}

async function runAllJobs() {
  const startTime = Date.now();

  try {
    // Check kill switch before running any jobs
    const config = await prisma.config.findUnique({
      where: { id: "singleton" },
    });

    if (config?.killSwitchActive) {
      console.log("[Worker] Kill switch is active. Skipping all jobs.");
      return;
    }

    // Run jobs sequentially
    console.log("[Worker] Running scan job...");
    await runScanJob();

    console.log("[Worker] Running reconcile job...");
    await runReconcileJob();

    console.log("[Worker] Running exit check job...");
    await runExitCheckJob();

    const duration = Date.now() - startTime;
    console.log(`[Worker] All jobs completed in ${duration}ms`);
  } catch (error) {
    console.error("[Worker] Job execution failed:", error);
    // Log error to database
    await prisma.log.create({
      data: {
        level: "ERROR",
        category: "SYSTEM",
        message: `Worker job execution failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: {
          stack: error instanceof Error ? error.stack : undefined,
        },
      },
    });
  }
}

// Handle graceful shutdown
process.on("SIGTERM", async () => {
  console.log("[Worker] Received SIGTERM, shutting down...");
  stopClobUserWs();
  await prisma.$disconnect();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("[Worker] Received SIGINT, shutting down...");
  stopClobUserWs();
  await prisma.$disconnect();
  process.exit(0);
});

main().catch(async (error) => {
  console.error("[Worker] Fatal error:", error);
  await prisma.$disconnect();
  process.exit(1);
});
