import { PrismaClient } from "../src/generated/prisma/index.js";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is required for seeding");
}

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("Seeding database...");

  // Create default config if it doesn't exist
  const config = await prisma.config.upsert({
    where: { id: "singleton" },
    update: {},
    create: {
      id: "singleton",
      // Probability band
      minProb: 0.65,
      maxProb: 0.90,
      // Spread/liquidity gates
      maxSpread: 0.03,
      minLiquidity: 5000,
      // Sizing
      defaultStake: 50,
      maxStakePerMarket: 200,
      // Exposure caps
      maxExposurePerMarket: 500,
      maxExposurePerCategory: 2000,
      maxOpenPositions: 50,
      maxTotalExposure: 10000,
      // Take profit
      takeProfitThreshold: 0.95,
      // Slippage
      maxSlippage: 0.02,
      // Kill switch (off by default)
      killSwitchActive: false,
      // Scan interval
      scanInterval: 10,
      // Excluded categories
      excludedCategories: ["crypto"],
    },
  });

  console.log("Created default config:", config.id);

  // Log initial setup
  await prisma.log.create({
    data: {
      level: "INFO",
      category: "SYSTEM",
      message: "Database initialized with default configuration",
      metadata: {
        minProb: 0.65,
        maxProb: 0.90,
        excludedCategories: ["crypto"],
      },
    },
  });

  console.log("Database seeded successfully!");
}

main()
  .catch((e) => {
    console.error("Error seeding database:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
