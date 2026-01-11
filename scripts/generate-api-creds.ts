/**
 * Generate Polymarket CLOB API credentials from your private key.
 *
 * Usage:
 *   npx tsx scripts/generate-api-creds.ts
 *
 * Then enter your private key and (optionally) your Polymarket funder address.
 */

import { createInterface } from "readline";
import { Wallet } from "ethers";
import { ClobClient } from "@polymarket/clob-client";

const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137; // Polygon Mainnet

// Signature types from @polymarket/order-utils
const SIGNATURE_TYPE_EOA = 0;
const SIGNATURE_TYPE_POLY_GNOSIS_SAFE = 2;

async function prompt(question: string, hidden = false): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    if (hidden) {
      process.stdout.write(question);
      let input = "";

      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");

      const onData = (char: string) => {
        if (char === "\n" || char === "\r") {
          process.stdin.setRawMode(false);
          process.stdin.removeListener("data", onData);
          process.stdout.write("\n");
          rl.close();
          resolve(input);
        } else if (char === "\u0003") {
          // Ctrl+C
          process.exit();
        } else if (char === "\u007F") {
          // Backspace
          if (input.length > 0) {
            input = input.slice(0, -1);
          }
        } else {
          input += char;
        }
      };

      process.stdin.on("data", onData);
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

async function main() {
  console.log("\n=== Polymarket API Credential Generator ===\n");

  let pk = await prompt("Enter your private key (starts with 0x): ", true);

  if (!pk.startsWith("0x")) {
    console.log("Warning: Key should start with 0x, adding prefix...");
    pk = "0x" + pk;
  }

  console.log("\nCreating wallet from private key...");

  // Create ethers Wallet from private key
  const wallet = new Wallet(pk);
  console.log(`Signer wallet address: ${wallet.address}`);

  // Ask for funder address
  console.log("\n--- Polymarket Proxy Wallet Setup ---");
  console.log("If you use Polymarket.com with MetaMask, your funds are in a proxy wallet.");
  console.log("Find your proxy wallet address at: polymarket.com -> Profile -> Wallet Address");
  console.log("(Leave blank if trading directly from your EOA)\n");

  const funderAddress = await prompt("Enter your Polymarket funder/proxy wallet address (or press Enter to skip): ");

  const signatureType = funderAddress ? SIGNATURE_TYPE_POLY_GNOSIS_SAFE : SIGNATURE_TYPE_EOA;

  if (funderAddress) {
    console.log(`\nUsing Gnosis Safe mode (signature type: ${signatureType})`);
    console.log(`Signer: ${wallet.address}`);
    console.log(`Funder: ${funderAddress}`);
  } else {
    console.log(`\nUsing direct EOA mode (signature type: ${signatureType})`);
  }

  console.log("\nConnecting to Polymarket CLOB...");

  try {
    // Create client with appropriate signature type and funder
    const client = new ClobClient(
      CLOB_HOST,
      CHAIN_ID,
      wallet,
      undefined, // No existing creds
      signatureType,
      funderAddress || undefined
    );

    console.log("Generating API credentials (this may take a moment)...");

    let creds;
    try {
      // Try to derive existing credentials first
      creds = await client.deriveApiKey();
      console.log("Found existing credentials.");
    } catch {
      // Create new credentials if none exist
      console.log("Creating new credentials...");
      creds = await client.createApiKey();
    }

    console.log("\n" + "=".repeat(60));
    console.log("SUCCESS! Add these to your .env file:");
    console.log("=".repeat(60));
    console.log(`\nPOLYMARKET_API_KEY=${creds.key}`);
    console.log(`POLYMARKET_API_SECRET=${creds.secret}`);
    console.log(`POLYMARKET_PASSPHRASE=${creds.passphrase}`);
    console.log(`WALLET_PRIVATE_KEY=${pk}`);
    if (funderAddress) {
      console.log(`POLYMARKET_FUNDER_ADDRESS=${funderAddress}`);
    }
    console.log("\n" + "=".repeat(60));
    console.log("Keep these credentials safe and never commit them!");
    console.log("=".repeat(60) + "\n");

  } catch (error) {
    console.error("\nError:", error);
    console.log("\nTroubleshooting:");
    console.log("- Make sure your private key is correct");
    console.log("- Check your internet connection");
    console.log("- If using a funder address, ensure it's the correct Polymarket proxy wallet");
    console.log("- Ensure you have funds deposited on Polymarket");
    process.exit(1);
  }
}

main();
