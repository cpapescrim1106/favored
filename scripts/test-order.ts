import "dotenv/config";
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";

const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;
const SIGNER_KEY = process.env.WALLET_PRIVATE_KEY!;
const API_KEY = process.env.POLYMARKET_API_KEY!;
const API_SECRET = process.env.POLYMARKET_API_SECRET!;
const PASSPHRASE = process.env.POLYMARKET_PASSPHRASE!;
const FUNDER_ADDRESS = process.env.POLYMARKET_FUNDER_ADDRESS!;

console.log("Env check:", {
  hasSignerKey: !!SIGNER_KEY,
  hasApiKey: !!API_KEY,
  hasFunder: !!FUNDER_ADDRESS,
});

// Token ID for khamenei YES (we have 10 tokens)
const TOKEN_ID = "101434403359553929764780234916919166959889590658679054429843672204390513588056";

async function main() {
  console.log("Setting up CLOB client...");
  console.log("Signer:", new Wallet(SIGNER_KEY).address);
  console.log("Funder (Safe):", FUNDER_ADDRESS);

  const signer = new Wallet(SIGNER_KEY);
  const creds = { key: API_KEY, secret: API_SECRET, passphrase: PASSPHRASE };

  // Create client with Safe configuration
  const client = new ClobClient(
    CLOB_HOST,
    CHAIN_ID,
    signer,
    creds,
    2, // signatureType = POLY_GNOSIS_SAFE
    FUNDER_ADDRESS
  );

  // First check balance/allowance
  console.log("\nChecking balance/allowance for CONDITIONAL token...");
  try {
    const balanceCheck = await client.getBalanceAllowance({
      asset_type: 1, // CONDITIONAL
      token_id: TOKEN_ID,
    });
    console.log("Balance/Allowance:", JSON.stringify(balanceCheck, null, 2));
  } catch (e) {
    console.error("Balance check error:", e);
  }

  // Try to place a tiny SELL order (1 token at 0.22)
  console.log("\nAttempting to place SELL order: 1 token @ 0.22...");
  try {
    const order = await client.createOrder({
      tokenID: TOKEN_ID,
      side: "SELL" as any,
      price: 0.22,
      size: 1,
    });
    console.log("Created order:", JSON.stringify(order, null, 2));

    const result = await client.postOrder(order, 0 as any); // GTC
    console.log("Post result:", JSON.stringify(result, null, 2));
  } catch (e: any) {
    console.error("Order error:", e.message);
    if (e.response) {
      console.error("Response data:", JSON.stringify(e.response.data, null, 2));
    }
  }

  // Also try a BUY order to see if both fail
  console.log("\nAttempting to place BUY order: 1 token @ 0.20...");
  try {
    const buyOrder = await client.createOrder({
      tokenID: TOKEN_ID,
      side: "BUY" as any,
      price: 0.20,
      size: 1,
    });
    console.log("Created buy order:", JSON.stringify(buyOrder, null, 2));

    const result = await client.postOrder(buyOrder, 0 as any); // GTC
    console.log("Post result:", JSON.stringify(result, null, 2));
  } catch (e: any) {
    console.error("Buy order error:", e.message);
    if (e.response) {
      console.error("Response data:", JSON.stringify(e.response.data, null, 2));
    }
  }
}

main().catch(console.error);
