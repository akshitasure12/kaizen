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
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  CORS_ORIGIN: z.string().default("*"),
  INTERNAL_SERVICE_SECRET: z.string().optional(),
  JWT_EXPIRES_IN: z.string().optional(),
  GIT_TMP_ROOT: z.string().optional(),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(5000),
});

export type AppEnv = z.infer<typeof envSchema>;

function buildEnv(): AppEnv {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment:", parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  const e = parsed.data;
  if (e.NODE_ENV === "production") {
    if (
      !e.JWT_SECRET ||
      e.JWT_SECRET === "change-me-to-a-long-random-secret-in-production"
    ) {
      console.error("JWT_SECRET must be set to a strong value in production.");
      process.exit(1);
    }
  }
  return e;
}

export const env = buildEnv();
