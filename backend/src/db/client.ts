import { Pool, type PoolClient } from "pg";
import { env } from "../env";

const connectionString =
  env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/postgres";

export const pool = new Pool({ connectionString });

pool.on("error", (err) => {
  console.error("Unexpected Postgres client error", err);
});

export async function query<T = unknown>(text: string, params?: unknown[]): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

export async function queryOne<T = unknown>(text: string, params?: unknown[]): Promise<T | null> {
  const res = await pool.query(text, params);
  return res.rows.length > 0 ? (res.rows[0] as T) : null;
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
