import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import { findRootEnvPath } from "./lib/find-root-env";

const rootEnv = findRootEnvPath();
if (rootEnv) loadDotenv({ path: rootEnv });
else loadDotenv();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url().optional(),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(5000),
  OPENAI_API_KEY: z.string().optional(),
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_PRIVATE_KEY: z.string().optional(),
});

export type WorkerEnv = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid worker environment:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
