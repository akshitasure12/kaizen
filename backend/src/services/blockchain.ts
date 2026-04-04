/**
 * Base Sepolia integration: AgentBranchToken (ABT) agent deposits + BountyPayment config.
 * AgentBranchToken.depositForAgent → AgentDeposit event (see contracts/src/interfaces/).
 */

import { ethers } from "ethers";
import { env } from "../env";

const BASE_SEPOLIA_CHAIN_ID = 84532n;

/** ABI subset for AgentBranchToken — keep in sync with contracts/src/AgentBranchToken.sol */
const ABT_IFACE = new ethers.Interface([
  "function depositForAgent(string ensName)",
  "function AGENT_DEPOSIT() view returns (uint256)",
  "function treasury() view returns (address)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "event AgentDeposit(address indexed user, string ensName, uint256 amount)",
]);

function isChecksummedAddress(s: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(s.trim());
}

function getRpcUrl(): string | null {
  const u = env.BASE_SEPOLIA_RPC_URL?.trim();
  return u || null;
}

function getAbtAddress(): string | null {
  const a = env.ABT_CONTRACT_ADDRESS?.trim();
  if (!a || !isChecksummedAddress(a)) return null;
  return ethers.getAddress(a);
}

let cachedProvider: ethers.JsonRpcProvider | null = null;

function getProvider(): ethers.JsonRpcProvider | null {
  const url = getRpcUrl();
  if (!url) return null;
  if (!cachedProvider) cachedProvider = new ethers.JsonRpcProvider(url);
  return cachedProvider;
}

export function isBlockchainEnabled(): boolean {
  return Boolean(getRpcUrl() && getAbtAddress());
}

export function getBlockchainConfig() {
  return {
    enabled: isBlockchainEnabled(),
    chainId: 84532,
    rpcUrl: getRpcUrl(),
    abtContract: env.ABT_CONTRACT_ADDRESS?.trim() || null,
    bountyContract: env.BOUNTY_CONTRACT_ADDRESS?.trim() || null,
  };
}

export async function getTokenInfo(): Promise<{
  symbol: string;
  name: string;
  decimals: number;
  mock: boolean;
}> {
  if (!isBlockchainEnabled()) {
    return { symbol: "ABT", name: "AgentBranch Token", decimals: 18, mock: true };
  }
  const provider = getProvider()!;
  const abt = getAbtAddress()!;
  const c = new ethers.Contract(abt, ABT_IFACE, provider);
  const [name, symbol, decimals] = await Promise.all([
    c.name() as Promise<string>,
    c.symbol() as Promise<string>,
    c.decimals() as Promise<bigint>,
  ]);
  return { name, symbol, decimals: Number(decimals), mock: false };
}

export async function getRequiredDeposit(): Promise<bigint> {
  if (!isBlockchainEnabled()) return 0n;
  const provider = getProvider()!;
  const abt = getAbtAddress()!;
  const c = new ethers.Contract(abt, ABT_IFACE, provider);
  return (await c.AGENT_DEPOSIT()) as bigint;
}

export async function getTreasuryAddress(): Promise<string | null> {
  const fromEnv = env.TREASURY_ADDRESS?.trim();
  if (fromEnv && isChecksummedAddress(fromEnv)) {
    return ethers.getAddress(fromEnv);
  }
  if (!isBlockchainEnabled()) return fromEnv || null;
  try {
    const provider = getProvider()!;
    const abt = getAbtAddress()!;
    const c = new ethers.Contract(abt, ABT_IFACE, provider);
    const t = (await c.treasury()) as string;
    return ethers.getAddress(t);
  } catch {
    return null;
  }
}

export function generateMockTxHash(): string {
  const hex = Array.from({ length: 64 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
  return `0x${hex}`;
}

export interface VerifyDepositOptions {
  ensName: string;
}

/**
 * When chain is disabled: accepts any hash (mock).
 * When enabled: receipt must succeed on Base Sepolia, tx must call depositForAgent on ABT
 * with matching ensName, and AgentDeposit event must show the expected amount.
 */
export async function verifyDepositTransaction(
  txHash: string,
  opts: VerifyDepositOptions,
): Promise<{ valid: boolean; reason?: string }> {
  if (!isBlockchainEnabled()) {
    return { valid: true, reason: "mock_verify" };
  }

  const h = txHash.trim();
  if (!/^0x([A-Fa-f0-9]{64})$/.test(h)) {
    return { valid: false, reason: "invalid_tx_hash" };
  }

  const provider = getProvider();
  const abt = getAbtAddress();
  if (!provider || !abt) {
    return { valid: false, reason: "chain_not_configured" };
  }

  try {
    const net = await provider.getNetwork();
    if (net.chainId !== BASE_SEPOLIA_CHAIN_ID) {
      return {
        valid: false,
        reason: `wrong_chain: expected ${BASE_SEPOLIA_CHAIN_ID}, got ${net.chainId}`,
      };
    }

    const receipt = await provider.getTransactionReceipt(h);
    if (!receipt) {
      return { valid: false, reason: "receipt_not_found" };
    }
    if (receipt.status !== 1) {
      return { valid: false, reason: "transaction_reverted" };
    }

    const tx = await provider.getTransaction(h);
    if (!tx) {
      return { valid: false, reason: "transaction_not_found" };
    }
    if (tx.to?.toLowerCase() !== abt.toLowerCase()) {
      return { valid: false, reason: "tx_not_to_abt_contract" };
    }

    let decoded: ethers.TransactionDescription | null;
    try {
      decoded = ABT_IFACE.parseTransaction({ data: tx.data });
    } catch {
      return { valid: false, reason: "not_depositForAgent_call" };
    }
    if (!decoded || decoded.name !== "depositForAgent") {
      return { valid: false, reason: "not_depositForAgent_call" };
    }

    const calldataEns = decoded.args[0] as string;
    if (calldataEns.toLowerCase() !== opts.ensName.toLowerCase()) {
      return { valid: false, reason: "ens_name_mismatch" };
    }

    const token = new ethers.Contract(abt, ABT_IFACE, provider);
    const required = (await token.AGENT_DEPOSIT()) as bigint;

    let foundEvent = false;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== abt.toLowerCase()) continue;
      try {
        const ev = ABT_IFACE.parseLog({
          topics: log.topics as string[],
          data: log.data,
        });
        if (!ev || ev.name !== "AgentDeposit") continue;
        const amount = ev.args.amount as bigint;
        if (amount === required) {
          foundEvent = true;
          break;
        }
      } catch {
        /* not this log */
      }
    }

    if (!foundEvent) {
      return { valid: false, reason: "missing_or_invalid_agent_deposit_event" };
    }

    return { valid: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { valid: false, reason: `rpc_error: ${msg}` };
  }
}
