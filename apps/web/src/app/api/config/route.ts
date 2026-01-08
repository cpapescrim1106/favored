import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export async function GET() {
  try {
    let config = await prisma.config.findUnique({
      where: { id: "singleton" },
    });

    // Create default config if it doesn't exist
    if (!config) {
      config = await prisma.config.create({
        data: {
          id: "singleton",
          minProb: 0.65,
          maxProb: 0.90,
          maxSpread: 0.03,
          minLiquidity: 5000,
          defaultStake: 50,
          maxStakePerMarket: 200,
          maxExposurePerMarket: 500,
          maxExposurePerCategory: 2000,
          maxOpenPositions: 50,
          maxTotalExposure: 10000,
          takeProfitThreshold: 0.95,
          maxSlippage: 0.02,
          killSwitchActive: false,
          scanInterval: 10,
          excludedCategories: ["crypto"],
        },
      });
    }

    return NextResponse.json({
      minProb: Number(config.minProb),
      maxProb: Number(config.maxProb),
      maxSpread: Number(config.maxSpread),
      minLiquidity: Number(config.minLiquidity),
      defaultStake: Number(config.defaultStake),
      maxStakePerMarket: Number(config.maxStakePerMarket),
      maxExposurePerMarket: Number(config.maxExposurePerMarket),
      maxExposurePerCategory: Number(config.maxExposurePerCategory),
      maxOpenPositions: config.maxOpenPositions,
      maxTotalExposure: Number(config.maxTotalExposure),
      takeProfitThreshold: Number(config.takeProfitThreshold),
      maxSlippage: Number(config.maxSlippage),
      killSwitchActive: config.killSwitchActive,
      scanInterval: config.scanInterval,
      excludedCategories: config.excludedCategories,
    });
  } catch (error) {
    console.error("Failed to fetch config:", error);
    return NextResponse.json({ error: "Failed to fetch config" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();

    const config = await prisma.config.update({
      where: { id: "singleton" },
      data: {
        minProb: body.minProb,
        maxProb: body.maxProb,
        maxSpread: body.maxSpread,
        minLiquidity: body.minLiquidity,
        defaultStake: body.defaultStake,
        maxStakePerMarket: body.maxStakePerMarket,
        maxExposurePerMarket: body.maxExposurePerMarket,
        maxExposurePerCategory: body.maxExposurePerCategory,
        maxOpenPositions: body.maxOpenPositions,
        maxTotalExposure: body.maxTotalExposure,
        takeProfitThreshold: body.takeProfitThreshold,
        maxSlippage: body.maxSlippage,
        scanInterval: body.scanInterval,
        excludedCategories: body.excludedCategories,
      },
    });

    // Log config change
    await prisma.log.create({
      data: {
        level: "INFO",
        category: "SYSTEM",
        message: "Configuration updated",
        metadata: {
          changes: Object.keys(body),
        },
      },
    });

    return NextResponse.json({
      success: true,
      minProb: Number(config.minProb),
      maxProb: Number(config.maxProb),
    });
  } catch (error) {
    console.error("Failed to update config:", error);
    return NextResponse.json({ error: "Failed to update config" }, { status: 500 });
  }
}
