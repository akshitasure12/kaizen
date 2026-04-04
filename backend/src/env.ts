import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import { findRootEnvPath } from "./lib/find-root-env";

const rootEnv = findRootEnvPath();
if (rootEnv) {
  loadDotenv({ path: rootEnv });
} else {
  loadDotenv();
}

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().url().optional(),
  JWT_SECRET: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL_FAST: z.string().default("gemini-3.1-flash-lite-preview"),
  GEMINI_MODEL_BALANCED: z.string().default("gemini-3-flash-preview"),
  GEMINI_MODEL_COMPLEX: z.string().default("gemini-2.5-pro"),
  GEMINI_EMBEDDING_MODEL: z.string().default("gemini-embedding-001"),
  GEMINI_THINKING_BUDGET_LOW: z.coerce.number().int().default(0),
  GEMINI_THINKING_BUDGET_MEDIUM: z.coerce.number().int().default(512),
  GEMINI_THINKING_BUDGET_HIGH: z.coerce.number().int().default(2048),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  /** Public URL GitHub POSTs to (same path as Fastify: /integrations/github/webhook). Used when importing a repo (POST /repositories/import-from-github). */
  GITHUB_WEBHOOK_CALLBACK_URL: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().url().optional(),
  ),
  CORS_ORIGIN: z.string().default("*"),
  INTERNAL_SERVICE_SECRET: z.string().optional(),
  JWT_EXPIRES_IN: z.string().optional(),
  GIT_TMP_ROOT: z.string().optional(),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(5000),
  // Base Sepolia JSON-RPC (enables on-chain agent deposit verification)
  BASE_SEPOLIA_RPC_URL: z.string().optional(),
  // AgentBranchToken — required for deposit verification when RPC is set
  ABT_CONTRACT_ADDRESS: z.string().optional(),
  // BountyPayment escrow — optional; exposed in /blockchain/config
  BOUNTY_CONTRACT_ADDRESS: z.string().optional(),
  // Treasury override for /blockchain/treasury when not reading from token
  TREASURY_ADDRESS: z.string().optional(),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(1),
  LEASE_TTL_MS: z.coerce.number().int().positive().optional(),
  WORKER_LEASE_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  RETRY_MAX: z.coerce.number().int().positive().optional(),
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  WORKER_BASE_RETRY_MS: z.coerce.number().int().positive().default(5000),
  WORKER_MAX_RETRY_MS: z.coerce.number().int().positive().default(60000),
  WORKER_INSTANCE_ID: z.string().optional(),
  CLI_CONTEXT_HINTS_ENABLED: z
    .string()
    .default('true')
    .transform((value) => ['true', '1', 'yes', 'on'].includes(value.toLowerCase())),
  CLI_CONTEXT_HINTS_TOP_FILES: z.coerce.number().int().min(1).max(50).default(8),
  CLI_CONTEXT_HINTS_TOP_TESTS: z.coerce.number().int().min(1).max(30).default(5),
  CLI_CONTEXT_HINTS_HISTORY_LIMIT: z.coerce.number().int().min(5).max(500).default(80),
  PAYOUT_MIN_SCORE: z.coerce.number().min(0).max(1).optional(),
  PAYOUT_SCORE_FLOOR: z.coerce.number().min(0).max(1).default(0.4),
  PAYOUT_MIN_ABOVE_FLOOR: z.coerce.number().min(0).max(1).default(0.25),
  PAYOUT_EXP: z.coerce.number().positive().optional(),
  PAYOUT_EXPONENT: z.coerce.number().positive().default(1.2),
  REPUTATION_EWMA_ALPHA: z.coerce.number().min(0.01).max(1).default(0.2),
  NO_MERGE_PENALTY: z.coerce.number().min(0).max(1).optional(),
  REPUTATION_NO_MERGE_PENALTY: z.coerce.number().min(0).max(1).default(0.05),
  ASSIGNMENT_PERF_CAP: z.coerce.number().min(0).max(1).default(0.9),
  ASSIGNMENT_PERF_FLOOR: z.coerce.number().min(0).max(1).default(0.1),
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
});

export type AppEnv = z.infer<typeof envSchema>;

function buildEnv(): AppEnv {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment:", parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  const e = parsed.data;
  const normalized = {
    ...e,
    WORKER_LEASE_TIMEOUT_MS: e.LEASE_TTL_MS ?? e.WORKER_LEASE_TIMEOUT_MS,
    WORKER_MAX_ATTEMPTS: e.RETRY_MAX ?? e.WORKER_MAX_ATTEMPTS,
    PAYOUT_SCORE_FLOOR: e.PAYOUT_MIN_SCORE ?? e.PAYOUT_SCORE_FLOOR,
    PAYOUT_EXPONENT: e.PAYOUT_EXP ?? e.PAYOUT_EXPONENT,
    REPUTATION_NO_MERGE_PENALTY: e.NO_MERGE_PENALTY ?? e.REPUTATION_NO_MERGE_PENALTY,
    GITHUB_APP_PRIVATE_KEY: e.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  };
  if (normalized.NODE_ENV === "production") {
    if (
      !normalized.JWT_SECRET ||
      normalized.JWT_SECRET === "change-me-to-a-long-random-secret-in-production"
    ) {
      console.error("JWT_SECRET must be set to a strong value in production.");
      process.exit(1);
    }
    if (!normalized.CORS_ORIGIN || normalized.CORS_ORIGIN.trim() === "*") {
      console.error("CORS_ORIGIN must be an explicit allow-list in production.");
      process.exit(1);
    }
  }
  return normalized;
}

export const env = buildEnv();
