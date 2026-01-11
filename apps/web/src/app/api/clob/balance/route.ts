import { NextResponse } from "next/server";
import {
  initializeClobClient,
  isCLOBConfigured,
} from "@favored/shared/polymarket";

export async function GET() {
  try {
    if (!isCLOBConfigured()) {
      return NextResponse.json({
        error: "CLOB not configured",
      }, { status: 400 });
    }

    const { client, wallet } = await initializeClobClient();

    // Get balance and allowance for USDC (collateral)
    const balanceAllowance = await client.getBalanceAllowance({
      asset_type: "COLLATERAL" as import("@polymarket/clob-client").AssetType,
    });

    console.log("[BALANCE] Raw response:", JSON.stringify(balanceAllowance, null, 2));

    const balance = balanceAllowance?.balance || "0";
    const allowance = balanceAllowance?.allowance || "0";

    return NextResponse.json({
      walletAddress: wallet.address,
      raw: balanceAllowance,
      balance,
      allowance,
      balanceFormatted: `$${(parseFloat(balance) / 1e6).toFixed(2)}`,
      allowanceFormatted: `$${(parseFloat(allowance) / 1e6).toFixed(2)}`,
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
}
