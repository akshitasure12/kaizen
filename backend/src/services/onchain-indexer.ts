/**
 * Polls Base Sepolia (or configured chain) for ABT + BountyPayment logs and persists rows in onchain_events.
 */

import { ethers } from "ethers";
import { env } from "../env";
import { query, queryOne } from "../db/client";

const ABT_IFACE = new ethers.Interface([
  "event AgentDeposit(address indexed user, string ensName, uint256 amount)",
]);

const BOUNTY_IFACE = new ethers.Interface([
  "event BountyCreated(uint256 indexed bountyId, address indexed poster, uint256 amount, uint256 deadline, string issueId)",
  "event BountyAwarded(uint256 indexed bountyId, address indexed winner, uint256 amount)",
  "event BountyCancelled(uint256 indexed bountyId, address indexed poster, uint256 refundAmount, uint256 feeAmount)",
  "event BountyClaimed(uint256 indexed bountyId, address indexed claimant, uint256 amount)",
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function rpcUrl(): string | null {
  const u = env.BASE_SEPOLIA_RPC_URL?.trim();
  return u || null;
}

function abtAddr(): string | null {
  const a = env.ABT_CONTRACT_ADDRESS?.trim();
  if (!a || !/^0x[a-fA-F0-9]{40}$/.test(a)) return null;
  return ethers.getAddress(a);
}

function bountyAddr(): string | null {
  const a = env.BOUNTY_CONTRACT_ADDRESS?.trim();
  if (!a || !/^0x[a-fA-F0-9]{40}$/.test(a)) return null;
  return ethers.getAddress(a);
}

export function isOnchainIndexerEnabled(): boolean {
  return Boolean(env.DATABASE_URL && rpcUrl() && (abtAddr() || bountyAddr()));
}

let providerSingleton: ethers.JsonRpcProvider | null = null;

function getProvider(): ethers.JsonRpcProvider | null {
  const url = rpcUrl();
  if (!url) return null;
  if (!providerSingleton) providerSingleton = new ethers.JsonRpcProvider(url);
  return providerSingleton;
}

async function readLastBlock(chainId: number): Promise<number> {
  const row = await queryOne<{ last_processed_block: string }>(
    "SELECT last_processed_block::text as last_processed_block FROM onchain_indexer_state WHERE chain_id = $1",
    [chainId],
  );
  if (!row) return 0;
  return parseInt(row.last_processed_block, 10) || 0;
}

async function writeLastBlock(chainId: number, block: number): Promise<void> {
  await query(
    `INSERT INTO onchain_indexer_state (chain_id, last_processed_block)
     VALUES ($1, $2)
     ON CONFLICT (chain_id) DO UPDATE SET last_processed_block = $2`,
    [chainId, block],
  );
}

async function lookupIssueAgent(issueId: string): Promise<{
  issue_id: string;
  agent_id: string | null;
} | null> {
  const row = await queryOne<{ id: string; assigned_agent_id: string | null }>(
    "SELECT id, assigned_agent_id FROM issues WHERE id = $1",
    [issueId],
  );
  if (!row) return null;
  return { issue_id: row.id, agent_id: row.assigned_agent_id };
}

async function lookupBountyContext(
  chainId: number,
  bountyId: bigint,
): Promise<{ issue_id: string | null; agent_id: string | null }> {
  const row = await queryOne<{
    issue_id: string | null;
    agent_id: string | null;
  }>(
    `SELECT issue_id, agent_id FROM onchain_events
     WHERE chain_id = $1 AND event_name = 'BountyCreated' AND bounty_id = $2::bigint
     LIMIT 1`,
    [chainId, bountyId.toString()],
  );
  return {
    issue_id: row?.issue_id ?? null,
    agent_id: row?.agent_id ?? null,
  };
}

async function insertEvent(row: {
  chain_id: number;
  block_number: number;
  tx_hash: string;
  log_index: number;
  contract_address: string;
  event_name: string;
  payload: Record<string, unknown>;
  bounty_id: string | null;
  ens_name: string | null;
  issue_id: string | null;
  agent_id: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO onchain_events (
       chain_id, block_number, tx_hash, log_index, contract_address, event_name,
       payload, bounty_id, ens_name, issue_id, agent_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::bigint, $9, $10, $11)
     ON CONFLICT (tx_hash, log_index) DO NOTHING`,
    [
      row.chain_id,
      row.block_number,
      row.tx_hash,
      row.log_index,
      row.contract_address,
      row.event_name,
      JSON.stringify(row.payload),
      row.bounty_id,
      row.ens_name,
      row.issue_id,
      row.agent_id,
    ],
  );
}

export async function runOnchainIndexerCycle(): Promise<void> {
  if (!isOnchainIndexerEnabled()) return;

  const provider = getProvider();
  if (!provider) return;

  const chainId = env.ONCHAIN_CHAIN_ID;
  const abt = abtAddr();
  const bounty = bountyAddr();

  let latest: number;
  try {
    latest = Number(await provider.getBlockNumber());
  } catch (e) {
    console.warn("[onchain-indexer] getBlockNumber failed:", e);
    return;
  }

  const last = await readLastBlock(chainId);
  let fromBlock = last > 0 ? last + 1 : undefined;

  if (fromBlock === undefined) {
    if (env.ONCHAIN_INDEXER_FROM_BLOCK != null) {
      fromBlock = env.ONCHAIN_INDEXER_FROM_BLOCK;
    } else {
      fromBlock = Math.max(0, latest - 5000);
    }
  }

  if (fromBlock > latest) return;

  const chunk = env.ONCHAIN_INDEXER_BLOCK_CHUNK;
  const toBlock = Math.min(fromBlock + chunk - 1, latest);

  const abtLogs =
    abt != null
      ? await provider
          .getLogs({
            address: abt,
            fromBlock,
            toBlock,
            topics: [ABT_IFACE.getEvent("AgentDeposit")!.topicHash],
          })
          .catch((e) => {
            console.warn("[onchain-indexer] ABT getLogs failed:", e);
            return [] as ethers.Log[];
          })
      : [];

  const bountyTopicOr = bounty
    ? [
        BOUNTY_IFACE.getEvent("BountyCreated")!.topicHash,
        BOUNTY_IFACE.getEvent("BountyAwarded")!.topicHash,
        BOUNTY_IFACE.getEvent("BountyCancelled")!.topicHash,
        BOUNTY_IFACE.getEvent("BountyClaimed")!.topicHash,
      ]
    : [];

  const bountyLogs =
    bounty != null && bountyTopicOr.length
      ? await provider
          .getLogs({
            address: bounty,
            fromBlock,
            toBlock,
            topics: [bountyTopicOr],
          })
          .catch((e) => {
            console.warn("[onchain-indexer] Bounty getLogs failed:", e);
            return [] as ethers.Log[];
          })
      : [];

  const sorted = [...abtLogs, ...bountyLogs].sort((a, b) => {
    const ba = Number(a.blockNumber);
    const bb = Number(b.blockNumber);
    if (ba !== bb) return ba - bb;
    return (a.index ?? 0) - (b.index ?? 0);
  });

  for (const log of sorted) {
    const txHash = log.transactionHash;
    const logIndex = log.index;
    const blockNumber = Number(log.blockNumber);
    const contractAddress = ethers.getAddress(log.address);

    try {
      if (abt && contractAddress === abt) {
        const parsed = ABT_IFACE.parseLog({
          topics: log.topics as string[],
          data: log.data,
        });
        if (!parsed || parsed.name !== "AgentDeposit") continue;
        const ensName = String(parsed.args.ensName).toLowerCase();
        const user = String(parsed.args.user);
        const amount = (parsed.args.amount as bigint).toString();
        const agentRow = await queryOne<{ id: string }>(
          "SELECT id FROM agents WHERE lower(ens_name) = lower($1)",
          [ensName],
        );
        await insertEvent({
          chain_id: chainId,
          block_number: blockNumber,
          tx_hash: txHash,
          log_index: logIndex,
          contract_address: contractAddress,
          event_name: "AgentDeposit",
          payload: { user, ensName, amount },
          bounty_id: null,
          ens_name: ensName,
          issue_id: null,
          agent_id: agentRow?.id ?? null,
        });
        continue;
      }

      if (bounty && contractAddress === bounty) {
        const parsed = BOUNTY_IFACE.parseLog({
          topics: log.topics as string[],
          data: log.data,
        });
        if (!parsed) continue;
        const name = parsed.name;

        if (name === "BountyCreated") {
          const bountyId = parsed.args.bountyId as bigint;
          const poster = String(parsed.args.poster);
          const amount = (parsed.args.amount as bigint).toString();
          const deadline = (parsed.args.deadline as bigint).toString();
          const issueIdRaw = String(parsed.args.issueId);
          let issue_id: string | null = null;
          let agent_id: string | null = null;
          if (UUID_RE.test(issueIdRaw)) {
            const ctx = await lookupIssueAgent(issueIdRaw);
            if (ctx) {
              issue_id = ctx.issue_id;
              agent_id = ctx.agent_id;
            }
          }
          await insertEvent({
            chain_id: chainId,
            block_number: blockNumber,
            tx_hash: txHash,
            log_index: logIndex,
            contract_address: contractAddress,
            event_name: name,
            payload: {
              bountyId: bountyId.toString(),
              poster,
              amount,
              deadline,
              issueId: issueIdRaw,
            },
            bounty_id: bountyId.toString(),
            ens_name: null,
            issue_id,
            agent_id,
          });
          continue;
        }

        if (
          name === "BountyAwarded" ||
          name === "BountyCancelled" ||
          name === "BountyClaimed"
        ) {
          const bountyId = parsed.args.bountyId as bigint;
          const ctx = await lookupBountyContext(chainId, bountyId);
          const basePayload: Record<string, string> = {
            bountyId: bountyId.toString(),
          };
          if (name === "BountyAwarded") {
            basePayload.winner = String(parsed.args.winner);
            basePayload.amount = (parsed.args.amount as bigint).toString();
          } else if (name === "BountyCancelled") {
            basePayload.poster = String(parsed.args.poster);
            basePayload.refundAmount = (
              parsed.args.refundAmount as bigint
            ).toString();
            basePayload.feeAmount = (parsed.args.feeAmount as bigint).toString();
          } else {
            basePayload.claimant = String(parsed.args.claimant);
            basePayload.amount = (parsed.args.amount as bigint).toString();
          }
          await insertEvent({
            chain_id: chainId,
            block_number: blockNumber,
            tx_hash: txHash,
            log_index: logIndex,
            contract_address: contractAddress,
            event_name: name,
            payload: basePayload,
            bounty_id: bountyId.toString(),
            ens_name: null,
            issue_id: ctx.issue_id,
            agent_id: ctx.agent_id,
          });
        }
      }
    } catch (e) {
      console.warn("[onchain-indexer] log decode/insert skip:", txHash, logIndex, e);
    }
  }

  await writeLastBlock(chainId, toBlock);
}
