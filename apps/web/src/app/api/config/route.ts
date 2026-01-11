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
      // Market Making settings
      mmDefaultSpread: Number(config.mmDefaultSpread),
      mmDefaultOrderSize: Number(config.mmDefaultOrderSize),
      mmDefaultMaxInventory: Number(config.mmDefaultMaxInventory),
      mmDefaultSkewFactor: Number(config.mmDefaultSkewFactor),
      mmDefaultQuotingPolicy: config.mmDefaultQuotingPolicy,
      mmRefreshThreshold: Number(config.mmRefreshThreshold),
      mmMinTimeToResolution: config.mmMinTimeToResolution,
      mmEnabled: config.mmEnabled,
    });
  } catch (error) {
    console.error("Failed to fetch config:", error);
    return NextResponse.json({ error: "Failed to fetch config" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();

    // Build update data with only provided fields
    const updateData: Record<string, unknown> = {};
    if (body.minProb !== undefined) updateData.minProb = body.minProb;
    if (body.maxProb !== undefined) updateData.maxProb = body.maxProb;
    if (body.maxSpread !== undefined) updateData.maxSpread = body.maxSpread;
    if (body.minLiquidity !== undefined) updateData.minLiquidity = body.minLiquidity;
    if (body.defaultStake !== undefined) updateData.defaultStake = body.defaultStake;
    if (body.maxStakePerMarket !== undefined) updateData.maxStakePerMarket = body.maxStakePerMarket;
    if (body.maxExposurePerMarket !== undefined) updateData.maxExposurePerMarket = body.maxExposurePerMarket;
    if (body.maxExposurePerCategory !== undefined) updateData.maxExposurePerCategory = body.maxExposurePerCategory;
    if (body.maxOpenPositions !== undefined) updateData.maxOpenPositions = body.maxOpenPositions;
    if (body.maxTotalExposure !== undefined) updateData.maxTotalExposure = body.maxTotalExposure;
    if (body.takeProfitThreshold !== undefined) updateData.takeProfitThreshold = body.takeProfitThreshold;
    if (body.maxSlippage !== undefined) updateData.maxSlippage = body.maxSlippage;
    if (body.scanInterval !== undefined) updateData.scanInterval = body.scanInterval;
    if (body.excludedCategories !== undefined) updateData.excludedCategories = body.excludedCategories;
    // Market Making settings
    if (body.mmDefaultSpread !== undefined) updateData.mmDefaultSpread = body.mmDefaultSpread;
    if (body.mmDefaultOrderSize !== undefined) updateData.mmDefaultOrderSize = body.mmDefaultOrderSize;
    if (body.mmDefaultMaxInventory !== undefined) updateData.mmDefaultMaxInventory = body.mmDefaultMaxInventory;
    if (body.mmDefaultSkewFactor !== undefined) updateData.mmDefaultSkewFactor = body.mmDefaultSkewFactor;
    if (body.mmDefaultQuotingPolicy !== undefined) updateData.mmDefaultQuotingPolicy = body.mmDefaultQuotingPolicy;
    if (body.mmRefreshThreshold !== undefined) updateData.mmRefreshThreshold = body.mmRefreshThreshold;
    if (body.mmMinTimeToResolution !== undefined) updateData.mmMinTimeToResolution = body.mmMinTimeToResolution;
    if (body.mmEnabled !== undefined) updateData.mmEnabled = body.mmEnabled;

    const config = await prisma.config.update({
      where: { id: "singleton" },
      data: updateData,
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
