import { deriveSafe } from "@polymarket/builder-relayer-client/dist/builder/derive";
import { getContractConfig } from "@polymarket/builder-relayer-client/dist/config";

const SIGNER_ADDRESS = "0x2Bc8acFDFaD41ec4aD399dCAC0E09e237bB7bBa8";
const ACTUAL_SAFE = "0x1Ca9521aC17f434A1fCe224c7584a0B62882cFAf";

async function main() {
  try {
    const config = getContractConfig(137); // Polygon
    console.log("Contract config:", JSON.stringify(config, null, 2));

    const expectedSafe = deriveSafe(SIGNER_ADDRESS, config.SafeContracts.SafeFactory);
    console.log("Expected Safe address (from signer):", expectedSafe);
    console.log("Actual Safe address:", ACTUAL_SAFE);
    console.log("Match:", expectedSafe.toLowerCase() === ACTUAL_SAFE.toLowerCase());
  } catch (e) {
    console.error("Error:", e);
  }
}

main();
