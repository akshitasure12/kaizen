import fs from "fs";
import path from "path";
import pg from "pg";
import { config as loadDotenv } from "dotenv";
import { findRootEnvPath } from "../lib/find-root-env";

const rootEnv = findRootEnvPath();
if (rootEnv) loadDotenv({ path: rootEnv });
else loadDotenv();

const url = process.env.DATABASE_URL;

async function main() {
  if (!url) {
    console.error("migrate: DATABASE_URL is required.");
    process.exit(1);
  }
  const schemaPath = path.join(__dirname, "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf-8");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
    console.log("migrate: schema.sql applied.");
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
