import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import { findRootEnvPath } from "./lib/find-root-env";

const rootEnv = findRootEnvPath();
if (rootEnv) loadDotenv({ path: rootEnv });
else loadDotenv();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url().optional(),
  GIT_TMP_ROOT: z.string().optional(),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(5000),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(1),
  LEASE_TTL_MS: z.coerce.number().int().positive().optional(),
  WORKER_LEASE_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  RETRY_MAX: z.coerce.number().int().positive().optional(),
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  WORKER_BASE_RETRY_MS: z.coerce.number().int().positive().default(5000),
  WORKER_MAX_RETRY_MS: z.coerce.number().int().positive().default(60000),
  WORKER_INSTANCE_ID: z.string().optional(),
  WORKER_LOOP_MAX_CYCLES: z.coerce.number().int().min(1).max(6).default(2),
  WORKER_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(1000).max(15 * 60 * 1000).default(120000),
  WORKER_COMMAND_MAX_LENGTH: z.coerce.number().int().min(20).max(1000).default(400),
  WORKER_COMMAND_MAX_OUTPUT_BYTES: z.coerce.number().int().min(1024).max(256000).default(60000),
  WORKER_TOOL_MAX_COMMANDS: z.coerce.number().int().min(1).max(20).default(6),
  WORKER_ALLOWED_COMMANDS: z
    .string()
    .default("rg,sed,find,cat,ls,npm,bun,pnpm,yarn,pytest,vitest,node,python,python3,go,cargo")
    .transform((value) =>
      value
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0),
    ),
  WORKER_MEMORY_COMMIT_ENABLED: z
    .string()
    .default("true")
    .transform((value) => ["true", "1", "yes", "on"].includes(value.toLowerCase())),
  BACKEND_API_URL: z.string().url().default("http://localhost:3001"),
  INTERNAL_SERVICE_SECRET: z.string().optional(),
  WORKER_DRY_RUN: z.string().optional().default("false").transform((value) =>
    ["true", "1", "yes", "on"].includes(value.toLowerCase()),
  ),
  CLI_CONTEXT_HINTS_ENABLED: z
    .string()
    .default("true")
    .transform((value) => ["true", "1", "yes", "on"].includes(value.toLowerCase())),
  CLI_CONTEXT_HINTS_MAX_FILES: z.coerce.number().int().min(1).max(50).default(8),
  CLI_CONTEXT_HINTS_MAX_TESTS: z.coerce.number().int().min(1).max(30).default(5),
  CLI_CONTEXT_HINTS_SCAN_LIMIT: z.coerce.number().int().min(100).max(20000).default(4000),

  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL_FAST: z.string().default("gemini-3.1-flash-lite-preview"),
  GEMINI_MODEL_BALANCED: z.string().default("gemini-3-flash-preview"),
  GEMINI_MODEL_COMPLEX: z.string().default("gemini-2.5-pro"),
  GEMINI_THINKING_BUDGET_LOW: z.coerce.number().int().default(0),
  GEMINI_THINKING_BUDGET_MEDIUM: z.coerce.number().int().default(512),
  GEMINI_THINKING_BUDGET_HIGH: z.coerce.number().int().default(2048),

  PAYOUT_MIN_SCORE: z.coerce.number().min(0).max(1).optional(),
  PAYOUT_SCORE_FLOOR: z.coerce.number().min(0).max(1).default(0.4),
  PAYOUT_MIN_ABOVE_FLOOR: z.coerce.number().min(0).max(1).default(0.25),
  PAYOUT_EXP: z.coerce.number().positive().optional(),
  PAYOUT_EXPONENT: z.coerce.number().positive().default(1.2),

  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
});

export type WorkerEnv = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid worker environment:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

if (parsed.data.WORKER_ALLOWED_COMMANDS.length === 0) {
  console.error("Invalid worker environment: WORKER_ALLOWED_COMMANDS must include at least one command");
  process.exit(1);
}

export const env = {
  ...parsed.data,
  WORKER_LEASE_TIMEOUT_MS: parsed.data.LEASE_TTL_MS ?? parsed.data.WORKER_LEASE_TIMEOUT_MS,
  WORKER_MAX_ATTEMPTS: parsed.data.RETRY_MAX ?? parsed.data.WORKER_MAX_ATTEMPTS,
  PAYOUT_SCORE_FLOOR: parsed.data.PAYOUT_MIN_SCORE ?? parsed.data.PAYOUT_SCORE_FLOOR,
  PAYOUT_EXPONENT: parsed.data.PAYOUT_EXP ?? parsed.data.PAYOUT_EXPONENT,
  GITHUB_APP_PRIVATE_KEY: parsed.data.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n"),
};
