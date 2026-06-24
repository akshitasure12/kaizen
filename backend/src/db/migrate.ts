import fs from "fs";
import path from "path";
import pg from "pg";
import { config as loadDotenv } from "dotenv";
import { findRootEnvPath } from "../lib/find-root-env";

const rootEnv = findRootEnvPath();
if (rootEnv) loadDotenv({ path: rootEnv });
else loadDotenv();

const url = process.env.DATABASE_URL;

function migrationsDir(): string {
  return path.join(__dirname, "migrations");
}

function schemaPath(): string {
  return path.join(__dirname, "schema.sql");
}

async function ensureMigrationsTable(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function appliedVersions(client: pg.Client): Promise<Set<string>> {
  const { rows } = await client.query<{ version: string }>(
    "SELECT version FROM schema_migrations ORDER BY version ASC",
  );
  return new Set(rows.map((row) => row.version));
}

async function runIncrementalMigrations(client: pg.Client): Promise<void> {
  await ensureMigrationsTable(client);
  const applied = await appliedVersions(client);
  const dir = migrationsDir();

  if (!fs.existsSync(dir)) {
    console.log("migrate: no migrations directory; nothing to apply.");
    return;
  }

  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`migrate: skip ${file} (already applied)`);
      continue;
    }

    const sql = fs.readFileSync(path.join(dir, file), "utf-8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`migrate: applied ${file}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
}

async function runFullSchema(client: pg.Client): Promise<void> {
  const sql = fs.readFileSync(schemaPath(), "utf-8");
  await client.query(sql);
  console.log("migrate: destructive schema.sql applied (--full).");
}

async function main() {
  if (!url) {
    console.error("migrate: DATABASE_URL is required.");
    process.exit(1);
  }

  const fullReset =
    process.argv.includes("--full") || process.env.MIGRATE_FULL === "1";

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    if (fullReset) {
      await runFullSchema(client);
    } else {
      await runIncrementalMigrations(client);
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
