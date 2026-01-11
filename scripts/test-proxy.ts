/**
 * Test Surfshark proxy connection
 */

import { HttpsProxyAgent } from "https-proxy-agent";
import axios from "axios";
import * as dotenv from "dotenv";

dotenv.config();

const GEOBLOCK_URL = "https://polymarket.com/api/geoblock";

async function main() {
  console.log("=== Proxy Connection Test ===\n");

  const user = process.env.SURFSHARK_USER;
  const pass = process.env.SURFSHARK_PASS;
  const server = process.env.SURFSHARK_SERVER || process.env.SURFSHARK_HOST;
  const port = process.env.SURFSHARK_PORT || "80";

  console.log("Configuration:");
  console.log(`  User: ${user ? user.slice(0, 4) + "***" : "NOT SET"}`);
  console.log(`  Pass: ${pass ? "***" : "NOT SET"}`);
  console.log(`  Server: ${server || "NOT SET"}`);
  console.log(`  Port: ${port}`);
  console.log("");

  if (!user || !pass || !server) {
    console.error("ERROR: Missing proxy configuration");
    process.exit(1);
  }

  const proxyUrl = `http://${user}:${pass}@${server}:${port}`;
  console.log(`Proxy URL: http://${user.slice(0, 4)}***:***@${server}:${port}`);
  console.log("");

  // Test 1: Direct connection (no proxy)
  console.log("Test 1: Direct connection (no proxy)...");
  try {
    const directResp = await axios.get(GEOBLOCK_URL, { timeout: 10000 });
    console.log(`  Status: ${directResp.status}`);
    console.log(`  Blocked: ${directResp.data.blocked}`);
    console.log(`  Country: ${directResp.data.country}`);
  } catch (error) {
    console.log(`  Error: ${error instanceof Error ? error.message : error}`);
  }
  console.log("");

  // Test 2: Through proxy
  console.log("Test 2: Through Surfshark proxy...");
  try {
    const proxyAgent = new HttpsProxyAgent(proxyUrl);
    const proxyResp = await axios.get(GEOBLOCK_URL, {
      httpsAgent: proxyAgent,
      proxy: false,
      timeout: 30000,
    });
    console.log(`  Status: ${proxyResp.status}`);
    console.log(`  Blocked: ${proxyResp.data.blocked}`);
    console.log(`  Country: ${proxyResp.data.country}`);

    if (!proxyResp.data.blocked) {
      console.log("\n✓ SUCCESS! Proxy is working and you are NOT geoblocked.");
    } else {
      console.log("\n✗ Proxy connected but you are still blocked.");
      console.log("  Try a different server (Germany, UK, etc.)");
    }
  } catch (error) {
    console.log(`  Error: ${error instanceof Error ? error.message : error}`);
    if (axios.isAxiosError(error)) {
      console.log(`  Code: ${error.code}`);
      console.log(`  Response: ${error.response?.status} ${error.response?.statusText}`);
    }
    console.log("\n✗ FAILED: Could not connect through proxy.");
    console.log("  Check your Surfshark credentials and server address.");
  }
}

main();
