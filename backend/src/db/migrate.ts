/**
 * Single entrypoint for DB migrations (plan Phase 4).
 * Add versioned SQL or a runner here; scaffold only verifies connectivity.
 */
import { config as loadDotenv } from "dotenv";
import pg from "pg";
import { findRootEnvPath } from "../lib/find-root-env";

const rootEnv = findRootEnvPath();
if (rootEnv) loadDotenv({ path: rootEnv });
else loadDotenv();

const url = process.env.DATABASE_URL;

async function main() {
  if (!url) {
    console.log("migrate: DATABASE_URL not set — nothing to do (scaffold).");
    process.exit(0);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("SELECT 1");
    console.log("migrate: database reachable; no migration files applied yet.");
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
