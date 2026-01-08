import cron from "node-cron";
import { runScanJob } from "./jobs/scan.js";
import { runReconcileJob } from "./jobs/reconcile.js";
import { runExitCheckJob } from "./jobs/exit-check.js";
import { prisma } from "./lib/db.js";

const SCAN_INTERVAL = process.env.SCAN_INTERVAL || "*/10 * * * *"; // Every 10 minutes

async function main() {
  console.log("[Worker] Starting Favored worker service...");
  console.log(`[Worker] Scan interval: ${SCAN_INTERVAL}`);

  // Run initial scan on startup
  console.log("[Worker] Running initial scan...");
  await runAllJobs();

  // Schedule recurring jobs
  cron.schedule(SCAN_INTERVAL, async () => {
    console.log(`[Worker] Cron triggered at ${new Date().toISOString()}`);
    await runAllJobs();
  });

  console.log("[Worker] Worker service started. Waiting for scheduled jobs...");
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
  await prisma.$disconnect();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("[Worker] Received SIGINT, shutting down...");
  await prisma.$disconnect();
  process.exit(0);
});

main().catch(async (error) => {
  console.error("[Worker] Fatal error:", error);
  await prisma.$disconnect();
  process.exit(1);
});
