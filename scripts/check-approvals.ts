import { createPublicClient, http } from 'viem';
import { polygon } from 'viem/chains';

const CTF_ADDRESS = '0x4d97dcd97ec945f40cf65f87097ace5ea0476045';
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_CTF_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const SAFE_WALLET = '0x1Ca9521aC17f434A1fCe224c7584a0B62882cFAf';

const client = createPublicClient({
  chain: polygon,
  transport: http('https://polygon-rpc.com')
});

const ERC1155_ABI = [
  {
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'operator', type: 'address' }
    ],
    name: 'isApprovedForAll',
    outputs: [{ type: 'bool' }],
    stateMutability: 'view',
    type: 'function'
  }
] as const;

async function main() {
  console.log('Checking ERC1155 operator approvals for Safe wallet:', SAFE_WALLET);

  const operators = [
    { name: 'CTF_EXCHANGE', address: CTF_EXCHANGE as `0x${string}` },
    { name: 'NEG_RISK_CTF_EXCHANGE', address: NEG_RISK_CTF_EXCHANGE as `0x${string}` },
    { name: 'NEG_RISK_ADAPTER', address: NEG_RISK_ADAPTER as `0x${string}` }
  ];

  for (const op of operators) {
    try {
      const isApproved = await client.readContract({
        address: CTF_ADDRESS as `0x${string}`,
        abi: ERC1155_ABI,
        functionName: 'isApprovedForAll',
        args: [SAFE_WALLET as `0x${string}`, op.address]
      });
      const status = isApproved ? 'APPROVED' : 'NOT APPROVED';
      console.log(op.name + ' (' + op.address + '): ' + status);
    } catch (e) {
      console.error('Error checking ' + op.name + ':', e);
    }
  }
}

main();
