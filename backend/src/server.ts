import cors from "@fastify/cors";
import Fastify from "fastify";
import { env } from "./env";

function parseCorsOrigin(raw: string): boolean | string | string[] {
  const t = raw.trim();
  if (t === "*" || t === "") return true;
  const parts = t.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 1) return parts[0];
  return parts;
}

async function main() {
  const app = Fastify({
    logger: env.NODE_ENV === "development",
  });

  await app.register(cors, {
    origin: parseCorsOrigin(env.CORS_ORIGIN),
  });

  app.get("/health", async () => ({ ok: true }));

  app.get("/status", async () => ({
    ok: true,
    nodeEnv: env.NODE_ENV,
    hasDatabase: Boolean(env.DATABASE_URL),
    hasJwtSecret: Boolean(env.JWT_SECRET),
    hasOpenAi: Boolean(env.OPENAI_API_KEY),
    github: {
      app: Boolean(env.GITHUB_APP_ID && env.GITHUB_PRIVATE_KEY),
      oauth: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
      webhook: Boolean(env.GITHUB_WEBHOOK_SECRET),
    },
    corsOrigin: env.CORS_ORIGIN === "*" ? "*" : "[set]",
  }));

  await app.listen({ host: env.HOST, port: env.PORT });
  app.log.info(`API listening on http://${env.HOST}:${env.PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
