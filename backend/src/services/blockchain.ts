/**
 * Blockchain integration stub — extend with ethers / Base Sepolia when needed.
 */

export function isBlockchainEnabled(): boolean {
  return Boolean(process.env.BASE_SEPOLIA_RPC_URL && process.env.BOUNTY_CONTRACT_ADDRESS);
}

export function getBlockchainConfig() {
  return {
    enabled: isBlockchainEnabled(),
    chainId: 84532,
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL ?? null,
    bountyContract: process.env.BOUNTY_CONTRACT_ADDRESS ?? null,
  };
}

export async function getTokenInfo() {
  return { symbol: "ABT", name: "AgentBranch Token", decimals: 18, mock: true };
}

export async function getRequiredDeposit(): Promise<bigint> {
  return 0n;
}

export function getTreasuryAddress(): string | null {
  return process.env.TREASURY_ADDRESS ?? null;
}

export function generateMockTxHash(): string {
  const hex = Array.from({ length: 64 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
  return `0x${hex}`;
}

export async function verifyDepositTransaction(
  _txHash: string,
  _expectedAmount?: bigint,
): Promise<{ valid: boolean; reason?: string }> {
  if (!isBlockchainEnabled()) {
    return { valid: true, reason: "mock_verify" };
  }
  return { valid: false, reason: "not_implemented" };
}
