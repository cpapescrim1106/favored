import { NextResponse } from "next/server";
import {
  testClobConnection,
  isCLOBConfigured,
  checkGeoblock,
  getProxyConfigFromEnv,
  createProxyAgent,
} from "@favored/shared/polymarket";

export async function GET() {
  try {
    const skipGeoblock = process.env.SKIP_GEOBLOCK_CHECK === "true";

    // Check basic credential configuration
    const configured = isCLOBConfigured();
    const proxyConfig = getProxyConfigFromEnv();

    if (!configured) {
      return NextResponse.json({
        connected: false,
        error: "Missing CLOB credentials",
        configured: {
          apiKey: !!process.env.POLYMARKET_API_KEY,
          apiSecret: !!process.env.POLYMARKET_API_SECRET,
          passphrase: !!process.env.POLYMARKET_PASSPHRASE,
          privateKey: !!process.env.WALLET_PRIVATE_KEY,
        },
        proxy: {
          configured: !!proxyConfig,
          server: proxyConfig?.server,
        },
        skipGeoblock,
      });
    }

    let geoCheck: { blocked: boolean; country?: string; error?: string } = {
      blocked: false,
      country: "SKIPPED",
    };

    if (!skipGeoblock) {
      // Check geoblock status first
      const proxyAgent = proxyConfig ? createProxyAgent(proxyConfig) : undefined;
      geoCheck = await checkGeoblock(proxyAgent);

      if (geoCheck.blocked) {
        return NextResponse.json({
          connected: false,
          error: `Geoblocked: ${geoCheck.error}`,
          country: geoCheck.country,
          proxy: {
            configured: !!proxyConfig,
            server: proxyConfig?.server,
          },
          hint: proxyConfig
            ? "Proxy may not be working correctly. Check Surfshark credentials."
            : "Configure Surfshark proxy in .env OR set SKIP_GEOBLOCK_CHECK=true to test credentials",
        });
      }
    }

    // Full connection test
    const result = await testClobConnection();

    if (!result.success) {
      return NextResponse.json({
        connected: false,
        error: result.error,
        geoblock: skipGeoblock ? { skipped: true } : { blocked: false, country: geoCheck.country },
        proxy: {
          configured: !!proxyConfig,
          server: proxyConfig?.server,
        },
      }, { status: 500 });
    }

    return NextResponse.json({
      connected: true,
      walletAddress: result.walletAddress,
      openOrdersCount: result.openOrdersCount,
      usingProxy: result.usingProxy,
      geoblock: skipGeoblock
        ? { skipped: true, warning: "Real orders will fail without VPN!" }
        : { blocked: false, country: geoCheck.country },
      message: skipGeoblock
        ? "CLOB connection successful (geoblock check skipped)"
        : "CLOB connection successful!",
    });
  } catch (error) {
    return NextResponse.json({
      connected: false,
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
}
