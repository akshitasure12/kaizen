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
  WORKER_LEASE_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  WORKER_BASE_RETRY_MS: z.coerce.number().int().positive().default(5000),
  WORKER_MAX_RETRY_MS: z.coerce.number().int().positive().default(60000),
  WORKER_INSTANCE_ID: z.string().optional(),
  WORKER_DRY_RUN: z.string().optional().default("false").transform((value) =>
    ["true", "1", "yes", "on"].includes(value.toLowerCase()),
  ),

  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL_FAST: z.string().default("gemini-3.1-flash-lite-preview"),
  GEMINI_MODEL_BALANCED: z.string().default("gemini-3-flash-preview"),
  GEMINI_MODEL_COMPLEX: z.string().default("gemini-2.5-pro"),
  GEMINI_THINKING_BUDGET_LOW: z.coerce.number().int().default(0),
  GEMINI_THINKING_BUDGET_MEDIUM: z.coerce.number().int().default(512),
  GEMINI_THINKING_BUDGET_HIGH: z.coerce.number().int().default(2048),

  PAYOUT_SCORE_FLOOR: z.coerce.number().min(0).max(1).default(0.4),
  PAYOUT_MIN_ABOVE_FLOOR: z.coerce.number().min(0).max(1).default(0.25),
  PAYOUT_EXPONENT: z.coerce.number().positive().default(1.2),
});

export type WorkerEnv = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid worker environment:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
